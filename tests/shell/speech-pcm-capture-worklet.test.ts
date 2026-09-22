import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("speech PCM capture worklet", () => {
  it("publishes responsive levels before the first bounded audio batch", async () => {
    const messages: Array<{ type?: string; level?: number; bytes?: ArrayBuffer }> = [];
    let Processor: (new () => {
      port: { onmessage: ((event: { data?: unknown }) => void) | null };
      process(inputs: Float32Array[][]): boolean;
    }) | undefined;
    class AudioWorkletProcessor {
      port = {
        onmessage: null as ((event: { data?: unknown }) => void) | null,
        postMessage: vi.fn((message: { type?: string; level?: number; bytes?: ArrayBuffer }) => {
          messages.push(message);
        }),
      };
    }
    const source = await readFile(new URL("../../shell/public/speech-pcm-capture-worklet.js", import.meta.url), "utf8");
    vm.runInNewContext(source, {
      AudioWorkletProcessor,
      Float32Array,
      Int16Array,
      Math,
      Number,
      registerProcessor: (_name: string, registered: typeof Processor) => { Processor = registered; },
      sampleRate: 16_000,
    });
    if (!Processor) throw new Error("Speech capture processor was not registered");
    const processor = new Processor();
    const frame = new Float32Array(128).fill(0.25);

    for (let index = 0; index < 7; index += 1) {
      expect(processor.process([[frame]])).toBe(true);
    }

    const level = messages.find((message) => message.type === "level");
    expect(level?.level).toBeCloseTo(0.25, 5);
    expect(messages.some((message) => message.type === "audio")).toBe(false);
  });
});
