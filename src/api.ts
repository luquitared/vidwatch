import { GoogleGenAI, MediaResolution, type Part } from "@google/genai";

export const DEFAULT_MODEL = "gemini-3.6-flash";

export const RESOLUTIONS: Record<string, MediaResolution> = {
  low: MediaResolution.MEDIA_RESOLUTION_LOW,
  medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  high: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

export function getClient(apiKey?: string): GoogleGenAI {
  const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) {
    console.error("error: no API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY), or pass --api-key.");
    process.exit(1);
  }
  return new GoogleGenAI({ apiKey: key });
}

export function isYouTubeUrl(input: string): boolean {
  return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(input);
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", mpeg: "video/mpeg", mpg: "video/mpg", mov: "video/mov",
  avi: "video/avi", flv: "video/x-flv", webm: "video/webm", wmv: "video/wmv", "3gp": "video/3gpp",
};

export function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "video/mp4";
}

/** Upload a local file via the Files API and wait until it is ACTIVE. */
export async function uploadVideo(ai: GoogleGenAI, path: string, quiet = false): Promise<{ uri: string; mimeType: string; name: string }> {
  if (!quiet) console.error(`uploading ${path} ...`);
  let file = await ai.files.upload({ file: path, config: { mimeType: mimeFor(path) } });
  const name = file.name!;
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 1500));
    file = await ai.files.get({ name });
  }
  if (file.state !== "ACTIVE") {
    throw new Error(`file processing failed: state=${file.state}${file.error ? ` error=${JSON.stringify(file.error)}` : ""}`);
  }
  if (!quiet) console.error(`uploaded: ${name} (${file.uri})`);
  return { uri: file.uri!, mimeType: file.mimeType ?? mimeFor(path), name };
}

export interface AnalyzeParams {
  model: string;
  /** Files-API URI or YouTube URL */
  uri: string;
  mimeType?: string;
  prompt: string;
  fps?: number;
  startSec?: number;
  endSec?: number;
  resolution?: MediaResolution;
  jsonSchema?: object;
  temperature?: number;
}

export interface AnalyzeResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export async function analyze(ai: GoogleGenAI, p: AnalyzeParams): Promise<AnalyzeResult> {
  const videoMetadata: Record<string, unknown> = {};
  if (p.fps != null) videoMetadata.fps = p.fps;
  if (p.startSec != null) videoMetadata.startOffset = `${p.startSec}s`;
  if (p.endSec != null) videoMetadata.endOffset = `${p.endSec}s`;

  const videoPart: Part = {
    fileData: { fileUri: p.uri, ...(p.mimeType ? { mimeType: p.mimeType } : {}) },
    ...(Object.keys(videoMetadata).length ? { videoMetadata } : {}),
  };

  const response = await ai.models.generateContent({
    model: p.model,
    contents: [{ role: "user", parts: [videoPart, { text: p.prompt }] }],
    config: {
      ...(p.resolution ? { mediaResolution: p.resolution } : {}),
      ...(p.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: p.jsonSchema } : {}),
      ...(p.temperature != null ? { temperature: p.temperature } : {}),
    },
  });

  const u = response.usageMetadata;
  return {
    text: response.text ?? "",
    usage: {
      inputTokens: u?.promptTokenCount ?? 0,
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      totalTokens: u?.totalTokenCount ?? 0,
    },
  };
}
