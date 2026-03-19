import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SttProvider } from "./stt/base.js";

const MAX_VOICE_SIZE = 10 * 1024 * 1024; // 10MB

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
  } catch {
    return false;
  }
}

export interface VoiceNoteResult {
  filePath: string;
  transcript: string | null;
  durationMs: number;
  error?: string;
}

export async function handleVoiceNote(params: {
  audioUrl: string;
  channel: string;
  homePath: string;
  stt: SttProvider | null;
  extension?: string;
}): Promise<VoiceNoteResult> {
  const { audioUrl, channel, homePath, stt, extension = "ogg" } = params;
  const audioDir = join(homePath, "data", "audio");
  if (!existsSync(audioDir)) mkdirSync(audioDir, { recursive: true });

  const safeChannel = channel.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  const safeExt = (extension || "ogg").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const timestamp = Date.now();
  const fileName = `${safeChannel}-${timestamp}.${safeExt}`;
  const filePath = join(audioDir, fileName);

  if (!isAllowedAudioUrl(audioUrl)) {
    return {
      filePath,
      transcript: null,
      durationMs: 0,
      error: "Audio URL not allowed",
    };
  }

  const response = await fetch(audioUrl);
  if (!response.ok) {
    return {
      filePath,
      transcript: null,
      durationMs: 0,
      error: `Download failed: ${response.status}`,
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_VOICE_SIZE) {
    return {
      filePath,
      transcript: null,
      durationMs: 0,
      error: `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`,
    };
  }

  writeFileSync(filePath, buffer);

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
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { filePath, transcript: null, durationMs: 0, error };
  }
}
