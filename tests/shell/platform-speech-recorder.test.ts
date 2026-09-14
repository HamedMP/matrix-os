// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  encodePcm16Wav,
  encodePcm16WavBytes,
  normalizeSpeechInputLevel,
  resolveSpeechWorkletUrl,
  smoothSpeechInputLevel,
} from "../../shell/src/lib/platform-speech-recorder.js";

describe("platform speech PCM recorder", () => {
  it("packages bounded mono PCM16 samples as a structurally valid WAV", async () => {
    const recording = encodePcm16Wav([
      new Int16Array([0, 1, -1]),
      new Int16Array([32_767, -32_768]),
    ], 16_000);

    expect(recording.type).toBe("audio/wav");
    expect(recording.size).toBe(54);
    const bytes = new Uint8Array(await recording.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.getInt16(52, true)).toBe(-32_768);
  });

  it("exposes the same platform-neutral WAV bytes for native capture", async () => {
    const chunks = [new Int16Array([0, 32_767, -32_768])];
    const bytes = encodePcm16WavBytes(chunks, 16_000);
    const browserBytes = new Uint8Array(await encodePcm16Wav(chunks, 16_000).arrayBuffer());

    expect(bytes).toEqual(browserBytes);
    expect(bytes.byteLength).toBe(50);
  });

  it("rejects invalid sample rates and empty recordings", () => {
    expect(() => encodePcm16Wav([], 16_000)).toThrow(/empty/i);
    expect(() => encodePcm16Wav([new Int16Array([1])], 1)).toThrow(/sample rate/i);
  });

  it("normalizes microphone RMS values and uses fast attack with slower release", () => {
    expect(normalizeSpeechInputLevel(Number.NaN)).toBe(0);
    expect(normalizeSpeechInputLevel(-1)).toBe(0);
    expect(normalizeSpeechInputLevel(0)).toBe(0);
    expect(normalizeSpeechInputLevel(1)).toBe(1);
    expect(normalizeSpeechInputLevel(0.001)).toBeCloseTo(0, 5);
    expect(normalizeSpeechInputLevel(0.1)).toBeCloseTo(2 / 3, 2);

    const attacked = smoothSpeechInputLevel(0, 1);
    const released = smoothSpeechInputLevel(attacked, 0);
    expect(attacked).toBeGreaterThan(0.5);
    expect(released).toBeGreaterThan(0);
    expect(released).toBeLessThan(attacked);
  });

  it("binds the worklet asset to the explicit computer and runtime", () => {
    window.history.replaceState({}, "", "/vm/alice?runtime=studio");
    expect(resolveSpeechWorkletUrl()).toBe(
      `${window.location.origin}/vm/alice/~runtime/studio/speech-pcm-capture-worklet.js`,
    );
  });
});
