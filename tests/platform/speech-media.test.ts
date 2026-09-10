import { describe, expect, it } from "vitest";
import { SpeechMediaError, inspectSpeechWav } from "../../packages/platform/src/speech/media.js";

function pcmWav(options: {
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  declaredDataBytes?: number;
} = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = Math.floor(sampleRate * (options.durationMs ?? 1_000) / 1_000) * blockAlign;
  const declaredDataBytes = options.declaredDataBytes ?? dataBytes;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, declaredDataBytes, true);
  return bytes;
}

describe("speech media admission", () => {
  const limits = { maxBytes: 10 * 1024 * 1024, maxDurationMs: 120_000 };

  it("derives PCM duration from bounded sample data instead of client metadata", () => {
    expect(inspectSpeechWav(pcmWav({ durationMs: 1_250 }), limits)).toEqual({
      mediaType: "audio/wav",
      durationMs: 1_250,
      sampleRate: 16_000,
      channels: 1,
      sampleCountPerChannel: 20_000,
    });
  });

  it("rejects malformed, oversized, unsupported and duration-forged media", () => {
    expect(() => inspectSpeechWav(new Uint8Array(12), limits)).toThrow(SpeechMediaError);
    expect(() => inspectSpeechWav(pcmWav({ bitsPerSample: 12 }), limits)).toThrow(/unsupported/i);
    expect(() => inspectSpeechWav(pcmWav({ declaredDataBytes: 4_000_000 }), limits)).toThrow(/malformed/i);
    expect(() => inspectSpeechWav(pcmWav({ durationMs: 1_001 }), {
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 1_000,
    })).toThrow(/duration/i);
    expect(() => inspectSpeechWav(pcmWav(), { maxBytes: 44, maxDurationMs: 120_000 })).toThrow(/size/i);
  });

  it("caps chunk scanning work", () => {
    const bytes = pcmWav();
    const withChunks = new Uint8Array(bytes.byteLength + 9 * 130);
    withChunks.set(bytes.subarray(0, 12), 0);
    let offset = 12;
    for (let index = 0; index < 130; index += 1) {
      withChunks.set([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 0], offset);
      offset += 9;
    }
    withChunks.set(bytes.subarray(12), offset);
    new DataView(withChunks.buffer).setUint32(4, withChunks.byteLength - 8, true);
    expect(() => inspectSpeechWav(withChunks, { ...limits, maxChunks: 128 })).toThrow(/complex/i);
  });
});
