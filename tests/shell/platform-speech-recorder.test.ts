// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { encodePcm16Wav } from "../../shell/src/lib/platform-speech-recorder.js";

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

  it("rejects invalid sample rates and empty recordings", () => {
    expect(() => encodePcm16Wav([], 16_000)).toThrow(/empty/i);
    expect(() => encodePcm16Wav([new Int16Array([1])], 1)).toThrow(/sample rate/i);
  });
});
