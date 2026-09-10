import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SttProvider } from "./stt/base.js";

export const MAX_CHANNEL_VOICE_BYTES = 10 * 1024 * 1024;

const ALLOWED_AUDIO_HOSTS = new Set([
  "api.telegram.org",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "mmg.whatsapp.net",
  "files.slack.com",
]);

export function isAllowedAudioUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_AUDIO_HOSTS.has(parsed.hostname);
  } catch (err: unknown) {
    console.warn("[voice] Invalid audio URL:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface VoiceNoteResult {
  filePath: string;
  transcript: string | null;
  durationMs: number;
  error?: string;
}

function diagnosticErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  switch (error.name) {
    case "AbortError":
    case "Error":
    case "RangeError":
    case "SyntaxError":
    case "TimeoutError":
    case "TypeError":
      return error.name;
    default:
      return "UnknownError";
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "ENOENT";
}

async function readBoundedResponse(response: Response): Promise<Buffer | undefined> {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CHANNEL_VOICE_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength <= MAX_CHANNEL_VOICE_BYTES ? buffer : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CHANNEL_VOICE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function preserveOwnerAudio(filePath: string, buffer: Buffer): Promise<boolean> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporaryPath, "wx");
    await file.writeFile(buffer);
    await file.close();
    file = undefined;
    await rename(temporaryPath, filePath);
    return true;
  } catch (error: unknown) {
    console.warn("[voice] owner audio persistence failed", diagnosticErrorKind(error));
    if (file) {
      try {
        await file.close();
      } catch (closeError: unknown) {
        console.warn("[voice] owner audio handle cleanup failed", diagnosticErrorKind(closeError));
      }
    }
    try {
      await unlink(temporaryPath);
    } catch (unlinkError: unknown) {
      if (!isMissingFileError(unlinkError)) {
        console.warn("[voice] owner audio temp cleanup failed", diagnosticErrorKind(unlinkError));
      }
    }
    return false;
  }
}

export async function handleVoiceNote(params: {
  audioUrl?: string;
  audioBuffer?: Buffer;
  channel: string;
  homePath: string;
  stt: SttProvider | null;
  extension?: string;
}): Promise<VoiceNoteResult> {
  const { audioUrl, audioBuffer: preloadedBuffer, channel, homePath, stt, extension = "ogg" } = params;
  const audioDir = join(homePath, "data", "audio");
  await mkdir(audioDir, { recursive: true });

  const safeChannel = channel.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  const safeExt = (extension || "ogg").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const fileName = `${safeChannel}-${randomUUID()}.${safeExt}`;
  const filePath = join(audioDir, fileName);

  let buffer: Buffer;

  if (preloadedBuffer) {
    buffer = preloadedBuffer;
  } else {
    if (!audioUrl || !isAllowedAudioUrl(audioUrl)) {
      return {
        filePath,
        transcript: null,
        durationMs: 0,
        error: "Audio URL not allowed",
      };
    }

    let response: Response;
    try {
      response = await fetch(audioUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error: unknown) {
      console.warn("[voice] audio download failed", diagnosticErrorKind(error));
      return {
        filePath,
        transcript: null,
        durationMs: 0,
        error: "Audio download unavailable",
      };
    }
    if (!response.ok) {
      return {
        filePath,
        transcript: null,
        durationMs: 0,
        error: "Audio download unavailable",
      };
    }
    const downloaded = await readBoundedResponse(response);
    if (!downloaded) {
      return { filePath, transcript: null, durationMs: 0, error: "Audio exceeds the 10MB limit" };
    }
    buffer = downloaded;
  }

  if (buffer.length > MAX_CHANNEL_VOICE_BYTES) {
    return {
      filePath,
      transcript: null,
      durationMs: 0,
      error: "Audio exceeds the 10MB limit",
    };
  }

  if (!await preserveOwnerAudio(filePath, buffer)) {
    return { filePath, transcript: null, durationMs: 0, error: "Voice note could not be saved" };
  }

  if (!stt || !stt.isAvailable()) {
    return {
      filePath,
      transcript: null,
      durationMs: 0,
      error: "STT not available",
    };
  }

  try {
    const result = await stt.transcribe(buffer);
    return { filePath, transcript: result.text, durationMs: result.durationMs };
  } catch (error: unknown) {
    console.warn("[voice] transcription failed", diagnosticErrorKind(error));
    return { filePath, transcript: null, durationMs: 0, error: "Transcription unavailable" };
  }
}
