import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { OwnerAudioTranscriber } from "@matrix-os/kernel";
import type { SttProvider, SttResult } from "../voice/stt/base.js";
import type { PlatformSpeechClient } from "./platform-client.js";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_CONVERSION_TIMEOUT_MS = 30_000;

export type AudioToPcmWavConverter = (
  audio: Uint8Array,
  fileName: string,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export class ManagedSpeechConversionError extends Error {
  constructor() {
    super("Audio conversion failed");
    this.name = "ManagedSpeechConversionError";
  }
}

function pcm16MonoWav(pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength < 2 || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_AUDIO_BYTES - 44) {
    throw new ManagedSpeechConversionError();
  }
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

export function createFfmpegPcmWavConverter(options: {
  ffmpegPath?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
} = {}): AudioToPcmWavConverter {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
  const maxInputBytes = options.maxInputBytes ?? MAX_AUDIO_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_AUDIO_BYTES;
  if (ffmpegPath.length < 1 || ffmpegPath.length > 4_096 || ffmpegPath.includes("\0")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_AUDIO_BYTES
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 46 || maxOutputBytes > MAX_AUDIO_BYTES) {
    throw new Error("Managed speech conversion configuration is invalid");
  }

  return async (audio, fileName, callerSignal) => {
    if (callerSignal.aborted || audio.byteLength < 1 || audio.byteLength > maxInputBytes
      || fileName.length < 1 || fileName.length > 255 || fileName.includes("\0")) {
      throw new ManagedSpeechConversionError();
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([callerSignal, timeoutSignal]);
    const maximumPcmBytes = maxOutputBytes - 44;

    return new Promise<Uint8Array>((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", "pipe:0",
        "-map_metadata", "-1",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-acodec", "pcm_s16le",
        "-f", "s16le",
        "pipe:1",
      ], {
        shell: false,
        signal,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Uint8Array[] = [];
      let total = 0;
      let outputExceeded = false;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new ManagedSpeechConversionError());
      };
      child.once("error", fail);
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || outputExceeded) return;
        total += chunk.byteLength;
        if (total > maximumPcmBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(Uint8Array.from(chunk));
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0 || signal.aborted || outputExceeded || total < 2) {
          fail();
          return;
        }
        settled = true;
        resolve(pcm16MonoWav(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)));
      });
      child.stdin.end(Buffer.from(audio));
    });
  };
}

function requestId(): string {
  return `sp_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
}

async function transcribeManaged(options: {
  client: PlatformSpeechClient;
  converter: AudioToPcmWavConverter;
  audio: Uint8Array;
  fileName: string;
  signal: AbortSignal;
}): Promise<{ text: string; durationMs: number }> {
  const wav = await options.converter(options.audio, options.fileName, options.signal);
  const result = await options.client.transcribe({
    requestId: requestId(),
    sourceKind: "owner_audio",
    audio: wav,
    mediaType: "audio/wav",
    signal: options.signal,
  });
  return {
    text: result.outcome === "transcript" ? result.text : "",
    durationMs: result.audioDurationMs,
  };
}

export function createManagedOwnerAudioTranscriber(options: {
  client: PlatformSpeechClient;
  converter?: AudioToPcmWavConverter;
}): OwnerAudioTranscriber {
  const converter = options.converter ?? createFfmpegPcmWavConverter();
  return {
    transcribe: (input) => transcribeManaged({ ...input, client: options.client, converter }),
  };
}

export function createManagedChannelSttProvider(options: {
  client: PlatformSpeechClient;
  converter?: AudioToPcmWavConverter;
  timeoutMs?: number;
}): SttProvider {
  const converter = options.converter ?? createFfmpegPcmWavConverter();
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 90_000) {
    throw new Error("Managed channel speech timeout is invalid");
  }
  return {
    name: "matrix-platform-speech",
    isAvailable: () => true,
    async transcribe(audio: Buffer): Promise<SttResult> {
      const result = await transcribeManaged({
        client: options.client,
        converter,
        audio,
        fileName: "channel-audio",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ...result, language: "" };
    },
  };
}
