import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`error: ${cmd} not found. Install ffmpeg (brew install ffmpeg / apt install ffmpeg).`);
      process.exit(1);
    }
    throw r.error;
  }
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  return r.stdout;
}

export interface ProbeInfo {
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  sizeBytes: number;
  format: string;
}

export function probe(path: string): ProbeInfo {
  const out = run("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  const data = JSON.parse(out);
  const video = data.streams?.find((s: any) => s.codec_type === "video");
  return {
    duration: parseFloat(data.format?.duration ?? "0"),
    width: video?.width,
    height: video?.height,
    hasAudio: data.streams?.some((s: any) => s.codec_type === "audio") ?? false,
    sizeBytes: parseInt(data.format?.size ?? "0", 10),
    format: data.format?.format_name ?? "unknown",
  };
}

export interface FramesOptions {
  /** Explicit timestamps in seconds */
  at?: number[];
  /** Extract one frame every N seconds */
  every?: number;
  outDir: string;
  /** Scale frames to this width (keeps aspect ratio) */
  width?: number;
}

/** Extract frames as JPEGs. Returns the written file paths. */
export function extractFrames(path: string, opts: FramesOptions): string[] {
  mkdirSync(opts.outDir, { recursive: true });
  const stem = basename(path).replace(/\.[^.]+$/, "");
  const scale = opts.width ? ["-vf", `scale=${opts.width}:-2`] : [];
  const written: string[] = [];

  let times: number[];
  if (opts.at?.length) {
    times = opts.at;
  } else {
    const every = opts.every ?? 1;
    const { duration } = probe(path);
    times = [];
    for (let t = 0; t < duration; t += every) times.push(Math.round(t * 1000) / 1000);
  }

  for (const t of times) {
    const label = t.toFixed(3).replace(/\.?0+$/, "").replace(".", "_") || "0";
    const out = join(opts.outDir, `${stem}_t${label}s.jpg`);
    run("ffmpeg", ["-y", "-v", "quiet", "-ss", String(t), "-i", path, "-frames:v", "1", "-q:v", "3", ...scale, out]);
    written.push(out);
  }
  return written;
}
