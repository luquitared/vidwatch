export interface PromptOptions {
  /** Fixed timestamp bucket size in seconds; undefined = natural segmentation */
  interval?: number;
  /** True when fps > 1 → sub-second timestamps matter */
  subSecond?: boolean;
  /** Ignore the audio track entirely */
  noAudio?: boolean;
  /** Include a verbatim transcript section */
  transcript?: boolean;
  /** Extra output-style instruction appended to the default prompt */
  style?: string;
  /** Known duration in seconds (helps the model not hallucinate past the end) */
  duration?: number;
  /** True when we know (via ffprobe) the file has an audio track */
  hasAudio?: boolean;
}

const tsFormat = (subSecond?: boolean) =>
  subSecond ? "MM:SS.mmm (sub-second precision)" : "MM:SS";

export function defaultPrompt(opts: PromptOptions = {}): string {
  const segmentation =
    opts.interval != null
      ? `Break the timeline into fixed ${opts.interval}-second segments starting at 00:00 (e.g. 00:00-00:${String(opts.interval).padStart(2, "0")}, then the next ${opts.interval} seconds, and so on). Every segment must appear, even if nothing changes in it.`
      : `Break the timeline into segments at natural boundaries: shot cuts, scene changes, new speakers, new actions, or meaningful audio changes. Segments should be as fine-grained as the content demands.`;

  const audioLines = opts.noAudio
    ? ""
    : `- AUDIO: speech (quote it verbatim), speaker identity if inferable, music, sound effects, ambient sound, tone/volume changes. If silent, say "silent".\n`;

  // Without an explicit push, structured/JSON output tends to under-attend to the
  // audio track and report everything as silent (verified empirically).
  const audioEmphasis = opts.noAudio
    ? ""
    : opts.hasAudio
      ? `\nCRITICAL: this video HAS an audio track. Listen to it carefully from start to finish; short isolated sounds (beeps, clicks, single words) count and must be reported with exact timestamps in the segment where they occur.\n`
      : `\nListen carefully to any audio track from start to finish; short isolated sounds count and must be reported with exact timestamps.\n`;

  const transcriptSection = opts.transcript
    ? `\nAfter the timeline, output a TRANSCRIPT section: the full verbatim transcript of all speech with a ${tsFormat(opts.subSecond)} timestamp at each speaker turn or natural pause.\n`
    : "";

  const durationNote =
    opts.duration != null
      ? `The video is ${opts.duration.toFixed(1)} seconds long. Never output a timestamp beyond that.\n`
      : "";

  const base = `You are producing a precise text representation of a video for someone who cannot watch it. Your output is their only way to "see" and "hear" this video, so completeness and timestamp accuracy are critical.

${durationNote}${segmentation}

For each segment, output a line with the time range in ${tsFormat(opts.subSecond)} format, then:
- VISUAL: what is visible — people (appearance, position), objects, setting, actions, camera movement/framing, lighting, notable changes from the previous segment.
- TEXT: any on-screen text, captions, titles, or UI elements, quoted verbatim. Omit this line if there is none.
${audioLines}
Rules:
- Cover the ENTIRE video with no gaps between segments.
- Timestamps must align to what is actually shown/heard at that moment. Anchor them to observable events (a cut, a word being spoken, a sound starting).
- Be objective and specific: colors, counts, exact wording. Describe, don't interpret — except in the summary.
- Do not skip static or uneventful stretches; state that they are static.
${audioEmphasis}${transcriptSection}
End with a SUMMARY: one short paragraph describing what the video is, what happens overall, and its apparent purpose.`;

  return opts.style ? `${base}\n\nAdditional output instructions (these take precedence on style/format): ${opts.style}` : base;
}

/** JSON schema used with --json for machine-readable output. */
export function jsonSchema(opts: PromptOptions = {}) {
  return {
    type: "object",
    properties: {
      segments: {
        type: "array",
        description: "Chronological, gap-free timeline of the video.",
        items: {
          type: "object",
          properties: {
            start: { type: "string", description: `Segment start, ${tsFormat(opts.subSecond)}` },
            end: { type: "string", description: `Segment end, ${tsFormat(opts.subSecond)}` },
            visual: { type: "string", description: "Everything visible in this segment" },
            onScreenText: { type: "string", description: "Verbatim on-screen text, empty string if none" },
            ...(opts.noAudio
              ? {}
              : { audio: { type: "string", description: "Speech (verbatim), music, SFX; 'silent' if none" } }),
          },
          required: ["start", "end", "visual"],
        },
      },
      ...(opts.transcript
        ? {
            transcript: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  time: { type: "string" },
                  speaker: { type: "string" },
                  text: { type: "string" },
                },
                required: ["time", "text"],
              },
            },
          }
        : {}),
      summary: { type: "string" },
    },
    required: ["segments", "summary"],
  };
}
