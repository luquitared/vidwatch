# vidwatch

Give agents eyes for video. A Bun/TypeScript CLI that turns any video into an accurate, timestamped text timeline using Gemini video understanding — plus local frame extraction so an agent can *look* at specific moments.

```
vidwatch watch demo.mp4
```

```
00:00 - 00:01
VISUAL: Man sits cross-legged outside a 7-Eleven with hot dogs, energy drink, and soda.
TEXT: "Healthy lifestyle in your 20s", text bubble: "you coming to the gym?"
AUDIO: Text chime.

00:01 - 00:03
VISUAL: Man types a response on his phone.
...
SUMMARY
This comedic video parodies ...
```

## Install

Requires [Bun](https://bun.sh) and (for `frames`, `probe`, and `--chunk`) [ffmpeg](https://ffmpeg.org).

```sh
git clone https://github.com/luquitared/vidwatch && cd vidwatch
bun install
bun link          # makes `vidwatch` available globally
export GEMINI_API_KEY=...   # https://aistudio.google.com/apikey
```

## Commands

| Command | What it does |
|---|---|
| `vidwatch watch <file\|youtube-url\|files/ID>` | Analyze a video into a timestamped timeline (visual + on-screen text + audio) |
| `vidwatch frames <file>` | Extract JPEG frames locally with ffmpeg — no API call |
| `vidwatch probe <file>` | Duration/streams + token & cost estimates before you spend |
| `vidwatch models` | Recommended models |

Run `vidwatch help` for all flags.

## Watch options

- `-p, --prompt <text>` — replace the default prompt entirely.
- `--style <text>` — keep the default task, append output-style instructions.
- `-m, --model <id>` — default `gemini-3.6-flash`. Also good: `gemini-3.5-flash` (cheaper), `gemini-omni-flash-preview` (strongest video).
- `--fps <n>` — frame sampling rate, `(0, 24]`, default 1. Higher = better temporal precision and fast-motion detail at ~n× the frame tokens. Above 1 fps the CLI switches timestamps to `MM:SS.mmm`.
- `--res low|medium|high` — `mediaResolution`, tokens per frame (low ≈ 66, default ≈ 258). `low` is ~3× cheaper and fine for scene-level description; `high` helps with small on-screen text.
- `--start <sec> --end <sec>` — analyze a clip without re-encoding (server-side `videoMetadata` offsets).
- `--interval <sec>` — force fixed timestamp buckets (e.g. `5` → 5-second ranges). Default: the model segments by the natural shape of the video, which is usually better.
- `--chunk <sec> --concurrency <n> --overlap <sec>` — split into windows analyzed in parallel and merged (local files; needs ffprobe). Use for long videos when wall-clock matters.
- `--json` — structured output: `{ segments: [{start, end, visual, onScreenText, audio}], summary }`.
- `--transcript` — adds a verbatim speech transcript with per-turn timestamps.
- `--no-audio` — ignore the audio track (auto-set when ffprobe says the file has none).

## Accuracy notes (measured, not vibes)

Tested against a synthetic 15s ground-truth video (color cuts at exactly 3/6/9/12s, 0.5s beeps at exactly 5s and 10s) and real footage, on `gemini-3.6-flash`:

- **Single-shot on an uploaded file is the accuracy gold standard.** Default settings reproduced every ground-truth boundary and beep timestamp *exactly* (3/6/9/12s cuts, beeps at 5 and 10). On real footage expect ±1s at 1 fps.
- **1 fps sampling bounds precision.** The model sees one frame per second, so sub-second events land on the nearest second. Raise `--fps` when you need finer timing or fast motion; use the `MM:SS.sss` timestamps it enables.
- **Uploaded files ≫ YouTube URLs for timestamps.** YouTube-URL inputs are known to drift (minutes over a 30-min video). If timing matters, download the file and let vidwatch upload it.
- **Chunking is a speed/accuracy trade.** The Files API embeds per-second timestamp markers that are *absolute* and survive clipping, so chunks report absolute times directly (verified exact on ground truth). But chunk-boundary segments can be ~1s off, and overlap regions occasionally duplicate or misplace an event. Use `--chunk` for long videos, single-shot when precision matters.
- **Structured output under-attends to audio.** With a plain JSON schema request the model reported a clip with beeps as fully silent; the same clip in text mode heard both beeps. vidwatch mitigates this: the default prompt asserts the audio track exists (checked via ffprobe) and chunk mode uses text output parsed by regex. Still, prefer text mode when audio detail is critical.
- **Cost intuition** (Gemini charges per token): ~66–258 tokens per frame·fps + 32 tokens/s audio. A 1-minute video ≈ 6k tokens (low) / 18k tokens (default) at 1 fps → fractions of a cent on flash models. `vidwatch probe` prints estimates per file.

## For agents

- Start with `vidwatch probe` to size the job, then `vidwatch watch --json` for a machine-readable timeline.
- Re-analyzing the same video? Reuse the upload: the CLI prints `files/<id>` after uploading — pass it as the input for ~48h (skips upload; ffprobe-derived hints are unavailable in that mode).
- Timestamps in the timeline are trustworthy to about ±1s (exact on clean cuts). To *see* a moment yourself, extract frames locally: `vidwatch frames video.mp4 --at 12.5,14 --width 800` and read the JPEGs.
- To scan a long video cheaply: `--res low --chunk 120 --concurrency 6`, then re-run interesting ranges single-shot with `--start/--end --fps 5` for precision.

## Design notes

- Uses `@google/genai` (`ai.models.generateContent`) directly — full access to `videoMetadata` (`fps`, `startOffset`, `endOffset`) and `mediaResolution`, no wrapper lib.
- Local files always go through the Files API (works for any size up to 20GB, uploads are reusable).
- `frames` and `probe` are pure ffmpeg/ffprobe — no API key needed.
