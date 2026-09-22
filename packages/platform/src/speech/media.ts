import type { SpeechMediaType } from "@matrix-os/contracts";

const DEFAULT_MAX_CHUNKS = 128;
const MIN_WAV_BYTES = 44;
const SUPPORTED_SAMPLE_RATES = { min: 8_000, max: 96_000 } as const;
const SUPPORTED_CHANNELS = { min: 1, max: 8 } as const;
const SUPPORTED_BITS = new Set([8, 16, 24, 32]);

export type SpeechMediaErrorCode =
  | "invalid_size"
  | "malformed_media"
  | "unsupported_media"
  | "duration_exceeded"
  | "media_too_complex";

export class SpeechMediaError extends Error {
  constructor(readonly code: SpeechMediaErrorCode, message: string) {
    super(message);
    this.name = "SpeechMediaError";
  }
}

export interface SpeechMediaLimits {
  maxBytes: number;
  maxDurationMs: number;
  maxChunks?: number;
}

export interface InspectedSpeechMedia {
  mediaType: SpeechMediaType;
  durationMs: number;
  sampleRate: number;
  channels: number;
  sampleCountPerChannel: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function malformed(message = "Malformed WAV media"): never {
  throw new SpeechMediaError("malformed_media", message);
}

export function inspectSpeechWav(
  bytes: Uint8Array,
  limits: SpeechMediaLimits,
): InspectedSpeechMedia {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < MIN_WAV_BYTES
    || !Number.isSafeInteger(limits.maxDurationMs) || limits.maxDurationMs <= 0) {
    throw new Error("Speech media limits are invalid");
  }
  if (bytes.byteLength < MIN_WAV_BYTES || bytes.byteLength > limits.maxBytes) {
    throw new SpeechMediaError("invalid_size", "Speech media size is outside the allowed range");
  }
  const maxChunks = limits.maxChunks ?? DEFAULT_MAX_CHUNKS;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > DEFAULT_MAX_CHUNKS) {
    throw new Error("Speech media chunk limit is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new SpeechMediaError("unsupported_media", "Unsupported speech media container");
  }
  const declaredLength = view.getUint32(4, true) + 8;
  if (declaredLength !== bytes.byteLength) malformed();

  let offset = 12;
  let chunkCount = 0;
  let format: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    blockAlign: number;
    byteRate: number;
  } | undefined;
  let dataSize: number | undefined;

  while (offset + 8 <= bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > maxChunks) {
      throw new SpeechMediaError("media_too_complex", "Speech media is too complex");
    }
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) malformed();

    if (chunkId === "fmt ") {
      if (format || chunkSize < 16) malformed();
      const audioFormat = view.getUint16(chunkStart, true);
      const channels = view.getUint16(chunkStart + 2, true);
      const sampleRate = view.getUint32(chunkStart + 4, true);
      const byteRate = view.getUint32(chunkStart + 8, true);
      const blockAlign = view.getUint16(chunkStart + 12, true);
      const bitsPerSample = view.getUint16(chunkStart + 14, true);
      if (audioFormat !== 1 || !SUPPORTED_BITS.has(bitsPerSample)
        || channels < SUPPORTED_CHANNELS.min || channels > SUPPORTED_CHANNELS.max
        || sampleRate < SUPPORTED_SAMPLE_RATES.min || sampleRate > SUPPORTED_SAMPLE_RATES.max) {
        throw new SpeechMediaError("unsupported_media", "Unsupported WAV encoding");
      }
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (blockAlign !== expectedBlockAlign || byteRate !== sampleRate * expectedBlockAlign) malformed();
      format = { sampleRate, channels, bitsPerSample, blockAlign, byteRate };
    } else if (chunkId === "data") {
      if (dataSize !== undefined || chunkSize === 0) malformed();
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (offset !== bytes.byteLength || !format || dataSize === undefined) malformed();
  if (dataSize % format.blockAlign !== 0) malformed();
  const sampleCountPerChannel = dataSize / format.blockAlign;
  const durationMs = Math.ceil((sampleCountPerChannel * 1_000) / format.sampleRate);
  if (durationMs <= 0) malformed();
  if (durationMs > limits.maxDurationMs) {
    throw new SpeechMediaError("duration_exceeded", "Speech media duration exceeds the allowed limit");
  }
  return {
    mediaType: "audio/wav",
    durationMs,
    sampleRate: format.sampleRate,
    channels: format.channels,
    sampleCountPerChannel,
  };
}
