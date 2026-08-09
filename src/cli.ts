#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_MODEL, RESOLUTIONS, analyze, getClient, isYouTubeUrl, uploadVideo,
} from "./api";
import { defaultPrompt, jsonSchema, type PromptOptions } from "./prompts";
import { extractFrames, probe } from "./ffmpeg";

const HELP = `vidwatch — give agents eyes for video (Gemini video understanding)

USAGE
  vidwatch watch <file-or-youtube-url> [options]   Analyze a video into a timestamped text timeline
  vidwatch frames <file> [options]                 Extract frames as JPEGs (local, no API)
  vidwatch probe <file>                            Show duration/streams + token & cost estimate
  vidwatch models                                  List recommended models
  vidwatch help                                    This help

WATCH OPTIONS
  -p, --prompt <text>     Replace the default prompt entirely
      --style <text>      Keep the default task, append output-style instructions
  -m, --model <id>        Model (default: ${DEFAULT_MODEL})
      --fps <n>           Frame sampling rate, 0-24 (default: 1). Higher = better temporal
                          precision + more detail on fast motion, at ~n× frame-token cost
      --res <r>           low | medium | high — tokens per frame (low≈66, default≈258).
                          low is ~3× cheaper; high helps with small text/detail
      --start <sec>       Clip start offset (seconds)
      --end <sec>         Clip end offset (seconds)
      --interval <sec>    Force fixed timestamp buckets (e.g. 5 → 5s ranges).
                          Default: model segments by natural shape of the video
      --chunk <sec>       Split into windows of this size, analyzed concurrently,
                          merged with corrected absolute timestamps (local files only)
      --concurrency <n>   Parallel requests in chunk mode (default: 4)
      --overlap <sec>     Chunk overlap so boundary events aren't cut (default: 2)
      --json              Structured JSON output (segments[] + summary)
      --transcript        Also include a verbatim speech transcript
      --no-audio          Ignore the audio track
      --temperature <t>   Sampling temperature (default: model default)
      --api-key <key>     Override GEMINI_API_KEY / GOOGLE_API_KEY

FRAMES OPTIONS
      --at <t1,t2,...>    Timestamps in seconds (e.g. 1.5,3,7.25)
      --every <sec>       One frame every N seconds (default: 1)
      --out <dir>         Output directory (default: ./frames)
      --width <px>        Scale frames to this width

EXAMPLES
  vidwatch watch demo.mp4
  vidwatch watch demo.mp4 --fps 5 --res low --json
  vidwatch watch https://youtu.be/XXXX --interval 5
  vidwatch watch long.mp4 --chunk 120 --concurrency 6
  vidwatch frames demo.mp4 --at 2.5,7 --width 800
`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseTs(ts: string): number {
  const parts = ts.trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Parse the strict text timeline format back into segments. */
function parseTimeline(text: string): { segments: any[]; summary: string } {
  const segments: any[] = [];
  let summary = "";
  let cur: any = null;
  const tsRange = /^\s*\[?\s*(\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*[-–—]\s*(\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*\]?\s*$/;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(tsRange);
    if (m) {
      cur = { start: m[1], end: m[2], visual: "" };
      segments.push(cur);
      continue;
    }
    if (/^SUMMARY:?/i.test(line)) {
      summary = line.replace(/^SUMMARY:?\s*/i, "");
      cur = null;
      continue;
    }
    if (summary && !cur && line) { summary += " " + line; continue; }
    if (!cur) continue;
    const field = line.match(/^[-*]?\s*(VISUAL|TEXT|AUDIO):\s*(.*)$/i);
    if (field) {
      const key = field[1]!.toLowerCase();
      const val = field[2] ?? "";
      if (key === "visual") cur.visual = val;
      else if (key === "text") cur.onScreenText = val;
      else cur.audio = val;
    } else if (line && cur.visual) {
      cur.visual += " " + line;
    }
  }
  return { segments, summary };
}

function fmtTs(sec: number, subSecond = false): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = subSecond ? s.toFixed(3).padStart(6, "0") : String(Math.round(s)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

async function cmdWatch(input: string, values: any) {
  const isUrl = isYouTubeUrl(input);
  const isRef = /^files\//.test(input);
  if (!isUrl && !isRef && !existsSync(input)) fail(`file not found: ${input}`);
  if (!isUrl && !isRef) input = resolve(input);

  const fps = values.fps != null ? parseFloat(values.fps) : undefined;
  if (fps != null && (Number.isNaN(fps) || fps <= 0 || fps > 24)) fail("--fps must be in (0, 24]");
  const resolution = values.res ? RESOLUTIONS[values.res] ?? fail(`--res must be low|medium|high`) : undefined;
  const interval = values.interval != null ? parseFloat(values.interval) : undefined;
  const chunkSize = values.chunk != null ? parseFloat(values.chunk) : undefined;
  const concurrency = values.concurrency != null ? parseInt(values.concurrency, 10) : 4;
  const start = values.start != null ? parseFloat(values.start) : undefined;
  const end = values.end != null ? parseFloat(values.end) : undefined;
  const temperature = values.temperature != null ? parseFloat(values.temperature) : undefined;
  const model = values.model ?? DEFAULT_MODEL;
  const subSecond = fps != null && fps > 1;

  const ai = getClient(values["api-key"]);
  const isFileRef = /^files\//.test(input);

  // Probe local files (best effort): duration anchors the prompt and enables
  // chunking; hasAudio lets the prompt assert the audio track exists, which is
  // needed for reliable audio detection in JSON mode.
  let duration: number | undefined;
  let hasAudio: boolean | undefined;
  if (!isUrl && !isFileRef) {
    try {
      const info = probe(input);
      duration = info.duration;
      hasAudio = info.hasAudio;
    } catch { /* ffprobe unavailable — fine */ }
  }

  const promptOpts: PromptOptions = {
    interval, subSecond, hasAudio,
    noAudio: values["no-audio"] || hasAudio === false || undefined,
    transcript: values.transcript || undefined,
    style: values.style,
  };

  let uri: string;
  let mimeType: string | undefined;
  if (isUrl) {
    uri = input;
  } else if (isFileRef) {
    const f = await ai.files.get({ name: input });
    uri = f.uri!;
    mimeType = f.mimeType ?? "video/mp4";
  } else {
    const up = await uploadVideo(ai, input);
    uri = up.uri;
    mimeType = up.mimeType;
    console.error(`(reusable for ~48h: vidwatch watch ${up.name} ...)`);
  }

  // ---- single-shot path ----
  if (chunkSize == null) {
    const isClip = start != null || end != null;
    // Verified behavior: File API videos carry absolute per-second timestamp markers
    // that survive clipping, so clipped requests are asked for absolute timestamps.
    const clipNote = isClip
      ? `\n\nNote: you are seeing a clip from a longer video, spanning ${fmtTs(start ?? 0)} to ${end != null ? fmtTs(end) : "the end"} of the original. The timestamps embedded in the video are from the ORIGINAL video — report all timestamps as those absolute original-video times, NOT relative to the clip.`
      : "";
    const basePrompt = values.prompt ?? defaultPrompt({ ...promptOpts, duration: isClip ? undefined : duration });
    const prompt = basePrompt + clipNote;
    const res = await analyze(ai, {
      model, uri, mimeType, prompt, fps, resolution, temperature,
      startSec: start, endSec: end,
      jsonSchema: values.json ? jsonSchema(promptOpts) : undefined,
    });
    console.log(res.text);
    console.error(`\n[tokens] input=${res.usage.inputTokens} output=${res.usage.outputTokens} total=${res.usage.totalTokens}`);
    return;
  }

  // ---- chunked concurrent path ----
  if (isUrl) fail("--chunk requires a local file (needs ffprobe for duration)");
  if (duration == null) fail("--chunk requires ffprobe to determine duration");
  if (values.prompt) fail("--chunk uses the built-in prompt for merging; use --style to adjust output, or drop --chunk");

  const overlap = values.overlap != null ? parseFloat(values.overlap) : 2;
  const rangeStart = start ?? 0;
  const rangeEnd = end ?? duration;
  // Each chunk analyzes [core start, core end + overlap]; segments are attributed
  // to the chunk whose core window contains their start. Overlap prevents events
  // at chunk boundaries from being cut off mid-sound/mid-action.
  const windows: Array<{ s: number; e: number; clipEnd: number }> = [];
  for (let t = rangeStart; t < rangeEnd; t += chunkSize) {
    const e = Math.min(t + chunkSize, rangeEnd);
    windows.push({ s: t, e, clipEnd: Math.min(e + overlap, rangeEnd) });
  }
  console.error(`analyzing ${windows.length} chunks of ≤${chunkSize}s (+${overlap}s overlap) with concurrency ${concurrency} ...`);

  // Chunk requests use plain-text output parsed by regex, NOT JSON schema:
  // structured output measurably under-attends to the audio track on clipped
  // requests (verified — same clip heard in text mode, "silent" in JSON mode).
  // Key fact (verified): the File API embeds per-second timestamp markers that are
  // ABSOLUTE in the original video and survive startOffset/endOffset clipping, so
  // each chunk is asked for absolute timestamps — no shifting needed.
  const results: Array<{ win: { s: number; e: number; clipEnd: number }; data: any; usage: any }> = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, windows.length) }, async () => {
    while (idx < windows.length) {
      const i = idx++;
      const win = windows[i]!;
      const prompt =
        defaultPrompt({ ...promptOpts, duration: undefined }) +
        `\n\nNote: you are seeing a clip from a longer video, spanning ${fmtTs(win.s)} to ${fmtTs(win.clipEnd)} of the original. The timestamps embedded in the video are from the ORIGINAL video — report all timestamps as those absolute original-video times, NOT relative to the clip.` +
        `\n\nOutput format (follow it EXACTLY, no markdown headers, no extra prose):\n[MM:SS - MM:SS]\n- VISUAL: ...\n- TEXT: ... (omit this line if there is no on-screen text)\n- AUDIO: ...\n(repeat for each segment)\nSUMMARY: one paragraph`;
      const res = await analyze(ai, {
        model, uri, mimeType, prompt, fps, resolution, temperature,
        startSec: win.s, endSec: win.clipEnd,
      });
      results[i] = { win, data: parseTimeline(res.text), usage: res.usage };
      console.error(`  chunk ${i + 1}/${windows.length} [${fmtTs(win.s)}-${fmtTs(win.clipEnd)}] done (${res.usage.totalTokens} tok)`);
    }
  });
  await Promise.all(workers);

  // Merge: keep segments whose start falls inside the chunk's core window.
  const allSegments: any[] = [];
  const summaries: string[] = [];
  const allTranscript: any[] = [];
  let inTok = 0, outTok = 0;
  for (const { win, data, usage } of results) {
    inTok += usage.inputTokens; outTok += usage.outputTokens;
    for (const seg of data.segments ?? []) {
      const s = parseTs(seg.start);
      if (!Number.isNaN(s) && (s < win.s - 0.5 || s >= win.e)) continue;
      allSegments.push(seg);
    }
    for (const t of data.transcript ?? []) {
      const ts = parseTs(t.time);
      if (!Number.isNaN(ts) && (ts < win.s - 0.5 || ts >= win.e)) continue;
      allTranscript.push(t);
    }
    if (data.summary) summaries.push(data.summary);
  }
  allSegments.sort((a, b) => (parseTs(a.start) || 0) - (parseTs(b.start) || 0));
  allTranscript.sort((a, b) => (parseTs(a.time) || 0) - (parseTs(b.time) || 0));

  // Drop segments fully covered by the previous one (overlap duplicates).
  const deduped: any[] = [];
  for (const seg of allSegments) {
    const prev = deduped[deduped.length - 1];
    if (prev && parseTs(seg.start) >= parseTs(prev.start) && parseTs(seg.end) <= parseTs(prev.end)) continue;
    deduped.push(seg);
  }
  allSegments.length = 0;
  allSegments.push(...deduped);

  if (values.json) {
    const merged: any = { segments: allSegments, summary: summaries.join(" ") };
    if (allTranscript.length) merged.transcript = allTranscript;
    console.log(JSON.stringify(merged, null, 2));
  } else {
    for (const seg of allSegments) {
      console.log(`[${seg.start} - ${seg.end}]`);
      console.log(`  VISUAL: ${seg.visual}`);
      if (seg.onScreenText) console.log(`  TEXT: ${seg.onScreenText}`);
      if (seg.audio) console.log(`  AUDIO: ${seg.audio}`);
    }
    if (allTranscript.length) {
      console.log(`\nTRANSCRIPT`);
      for (const t of allTranscript) console.log(`  [${t.time}]${t.speaker ? ` ${t.speaker}:` : ""} ${t.text}`);
    }
    console.log(`\nSUMMARY (per chunk)\n${summaries.map((s, i) => `  chunk ${i + 1}: ${s}`).join("\n")}`);
  }
  console.error(`\n[tokens] input=${inTok} output=${outTok} total=${inTok + outTok}`);
}

function cmdFrames(input: string, values: any) {
  if (!existsSync(input)) fail(`file not found: ${input}`);
  const at = values.at ? String(values.at).split(",").map((s: string) => parseFloat(s)) : undefined;
  if (at?.some(Number.isNaN)) fail("--at must be comma-separated numbers (seconds)");
  const files = extractFrames(resolve(input), {
    at,
    every: values.every != null ? parseFloat(values.every) : undefined,
    outDir: values.out ?? "./frames",
    width: values.width != null ? parseInt(values.width, 10) : undefined,
  });
  for (const f of files) console.log(f);
  console.error(`\n${files.length} frames written`);
}

function cmdProbe(input: string) {
  if (!existsSync(input)) fail(`file not found: ${input}`);
  const info = probe(resolve(input));
  const dur = info.duration;
  const audioTok = info.hasAudio ? Math.round(dur * 32) : 0;
  const est = (fps: number, perFrame: number) => Math.round(dur * fps * perFrame) + audioTok;
  console.log(JSON.stringify({
    duration_sec: Math.round(dur * 100) / 100,
    resolution: info.width ? `${info.width}x${info.height}` : null,
    has_audio: info.hasAudio,
    size_mb: Math.round(info.sizeBytes / 1024 / 102.4) / 10,
    format: info.format,
    token_estimates: {
      "1fps_default_res": est(1, 258),
      "1fps_low_res": est(1, 66),
      "5fps_default_res": est(5, 258),
      "5fps_low_res": est(5, 66),
    },
    est_cost_usd_gemini_3_6_flash: {
      "1fps_default_res": Math.round(est(1, 258) * 1.5 / 1e6 * 1e5) / 1e5,
      "1fps_low_res": Math.round(est(1, 66) * 1.5 / 1e6 * 1e5) / 1e5,
    },
  }, null, 2));
}

function cmdModels() {
  console.log(`recommended models for video understanding:

  gemini-3.6-flash          default. newest flash; $1.50/$7.50 per 1M in/out tokens
  gemini-3.5-flash          previous flash generation; cheaper, still strong on video
  gemini-3.5-flash-lite     cheapest; fine for coarse summaries, weaker timestamps
  gemini-omni-flash-preview strongest native video understanding (preview; check availability)

any Gemini model with video input works via --model <id>.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" },
      style: { type: "string" },
      model: { type: "string", short: "m" },
      fps: { type: "string" },
      res: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      interval: { type: "string" },
      chunk: { type: "string" },
      concurrency: { type: "string" },
      json: { type: "boolean" },
      transcript: { type: "boolean" },
      "no-audio": { type: "boolean" },
      temperature: { type: "string" },
      "api-key": { type: "string" },
      overlap: { type: "string" },
      at: { type: "string" },
      every: { type: "string" },
      out: { type: "string" },
      width: { type: "string" },
    },
  });

  switch (cmd) {
    case "watch": {
      const input = positionals[0] ?? fail("usage: vidwatch watch <file-or-youtube-url>");
      await cmdWatch(input, values);
      break;
    }
    case "frames": {
      const input = positionals[0] ?? fail("usage: vidwatch frames <file>");
      cmdFrames(input, values);
      break;
    }
    case "probe": {
      const input = positionals[0] ?? fail("usage: vidwatch probe <file>");
      cmdProbe(input);
      break;
    }
    case "models":
      cmdModels();
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`error: ${e?.message ?? e}`);
  process.exit(1);
});
