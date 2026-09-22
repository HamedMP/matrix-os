const WAV_HEADER_BYTES = 44;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 96_000;
const MIN_METER_RMS = 0.001;
const METER_DECIBEL_RANGE = 60;

export class PlatformSpeechRecorderError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = "PlatformSpeechRecorderError";
  }
}

export function normalizeSpeechInputLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= MIN_METER_RMS) return 0;
  const decibels = 20 * Math.log10(Math.min(1, rms));
  return Math.max(0, Math.min(1, (decibels + METER_DECIBEL_RANGE) / METER_DECIBEL_RANGE));
}

export function smoothSpeechInputLevel(previous: number, next: number): number {
  const safePrevious = Number.isFinite(previous) ? Math.max(0, Math.min(1, previous)) : 0;
  const safeNext = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0;
  const response = safeNext >= safePrevious ? 0.7 : 0.22;
  return safePrevious + (safeNext - safePrevious) * response;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

export function encodePcm16WavBytes(chunks: readonly Int16Array[], sampleRate: number): Uint8Array {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new PlatformSpeechRecorderError("Unsupported microphone sample rate");
  }
  let sampleCount = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Int16Array) || chunk.length === 0) continue;
    sampleCount += chunk.length;
    if (!Number.isSafeInteger(sampleCount) || sampleCount > (0xffff_ffff - WAV_HEADER_BYTES) / 2) {
      throw new PlatformSpeechRecorderError("This recording is too large");
    }
  }
  if (sampleCount === 0) throw new PlatformSpeechRecorderError("This recording is empty");
  const bytes = new Uint8Array(WAV_HEADER_BYTES + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      view.setInt16(offset, chunk[index] ?? 0, true);
      offset += 2;
    }
  }
  return bytes;
}
