import { describe, it, expect } from "vitest";

import {
  pcmToMulaw,
  mulawToPcm,
  resample,
  convertToTelephony,
} from "../../../../packages/gateway/src/voice/audio/convert.js";

import {
  chunkAudio,
  reassemble,
} from "../../../../packages/gateway/src/voice/audio/chunking.js";

describe("pcmToMulaw", () => {
  it("encodes silence (0x0000) to mu-law 0xFF", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(0, 0);
    const result = pcmToMulaw(pcm);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(0xff);
  });

  it("encodes max positive (0x7FFF) to mu-law 0x80", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(0x7fff, 0);
    const result = pcmToMulaw(pcm);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(0x80);
  });

  it("encodes max negative (-32767 / 0x8001) to mu-law 0x00", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(-32767, 0);
    const result = pcmToMulaw(pcm);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(0x00);
  });

  it("round-trips PCM -> mu-law -> PCM within telephony tolerance", () => {
    const testValues = [0, 100, 1000, 5000, 10000, 20000, -100, -1000, -5000];
    for (const value of testValues) {
      const pcm = Buffer.alloc(2);
      pcm.writeInt16LE(value, 0);
      const encoded = pcmToMulaw(pcm);
      const decoded = mulawToPcm(encoded);
      const result = decoded.readInt16LE(0);
      const absValue = Math.abs(value);
      if (absValue === 0) {
        expect(result).toBe(0);
      } else {
        const relativeError = Math.abs(value - result) / absValue;
        expect(relativeError).toBeLessThan(0.05);
      }
    }
  });

  it("returns empty buffer for empty input", () => {
    const result = pcmToMulaw(Buffer.alloc(0));
    expect(result.length).toBe(0);
  });

  it("encodes multiple samples correctly", () => {
    const pcm = Buffer.alloc(6);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(1000, 2);
    pcm.writeInt16LE(-1000, 4);
    const result = pcmToMulaw(pcm);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xce);
    expect(result[2]).toBe(0x4e);
  });
});

describe("mulawToPcm", () => {
  it("decodes mu-law 0xFF (silence) to PCM ~0", () => {
    const mulaw = Buffer.from([0xff]);
    const result = mulawToPcm(mulaw);
    expect(result.length).toBe(2);
    expect(result.readInt16LE(0)).toBe(0);
  });

  it("round-trip accuracy for a range of mu-law values", () => {
    const mulawValues = [0x00, 0x10, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0, 0xff];
    for (const val of mulawValues) {
      const mulaw = Buffer.from([val]);
      const pcm = mulawToPcm(mulaw);
      const reEncoded = pcmToMulaw(pcm);
      expect(reEncoded[0]).toBe(val);
    }
  });

  it("returns empty buffer for empty input", () => {
    const result = mulawToPcm(Buffer.alloc(0));
    expect(result.length).toBe(0);
  });

  it("decodes multiple samples", () => {
    const mulaw = Buffer.from([0xff, 0xce, 0x4e]);
    const result = mulawToPcm(mulaw);
    expect(result.length).toBe(6);
    expect(result.readInt16LE(0)).toBe(0);
    expect(result.readInt16LE(2)).toBe(988);
    expect(result.readInt16LE(4)).toBe(-988);
  });
});

describe("resample", () => {
  it("44100Hz -> 8000Hz: output length is correct", () => {
    const inputSamples = 44100;
    const pcm = Buffer.alloc(inputSamples * 2);
    for (let i = 0; i < inputSamples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 10000), i * 2);
    }
    const result = resample(pcm, 44100, 8000);
    const expectedSamples = Math.round(inputSamples * 8000 / 44100);
    expect(result.length / 2).toBe(expectedSamples);
  });

  it("16000Hz -> 8000Hz: output length halved", () => {
    const inputSamples = 160;
    const pcm = Buffer.alloc(inputSamples * 2);
    for (let i = 0; i < inputSamples; i++) {
      pcm.writeInt16LE(i * 100, i * 2);
    }
    const result = resample(pcm, 16000, 8000);
    expect(result.length / 2).toBe(Math.round(inputSamples * 8000 / 16000));
  });

  it("8000Hz -> 8000Hz: passthrough (identical output)", () => {
    const pcm = Buffer.alloc(20);
    for (let i = 0; i < 10; i++) {
      pcm.writeInt16LE(i * 1000, i * 2);
    }
    const result = resample(pcm, 8000, 8000);
    expect(Buffer.compare(result, pcm)).toBe(0);
  });

  it("returns empty buffer for empty input", () => {
    const result = resample(Buffer.alloc(0), 44100, 8000);
    expect(result.length).toBe(0);
  });

  it("handles single sample buffer", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(5000, 0);
    const result = resample(pcm, 16000, 8000);
    expect(result.length).toBe(2);
    expect(result.readInt16LE(0)).toBe(5000);
  });
});

describe("convertToTelephony", () => {
  it("takes PCM at any sample rate, returns mu-law at 8kHz", () => {
    const inputSamples = 160;
    const pcm = Buffer.alloc(inputSamples * 2);
    for (let i = 0; i < inputSamples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 5000), i * 2);
    }
    const result = convertToTelephony(pcm, 16000);
    const expectedSamples = Math.round(inputSamples * 8000 / 16000);
    expect(result.length).toBe(expectedSamples);
  });

  it("passthrough rate produces correct output length", () => {
    const inputSamples = 80;
    const pcm = Buffer.alloc(inputSamples * 2);
    const result = convertToTelephony(pcm, 8000);
    expect(result.length).toBe(inputSamples);
  });
});

describe("chunkAudio", () => {
  it("20ms chunks at 8kHz = 160 bytes per chunk for mu-law", () => {
    const audio = Buffer.alloc(480);
    const chunks = chunkAudio(audio, 20, 8000, 1);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(160);
    }
  });

  it("20ms chunks at 8kHz 16-bit PCM = 320 bytes per chunk", () => {
    const audio = Buffer.alloc(960);
    const chunks = chunkAudio(audio, 20, 8000, 2);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(320);
    }
  });

  it("480 mu-law samples -> 3 chunks", () => {
    const audio = Buffer.alloc(480);
    const chunks = chunkAudio(audio, 20, 8000, 1);
    expect(chunks.length).toBe(3);
  });

  it("500 mu-law samples -> 3 full chunks + 1 partial (20 bytes)", () => {
    const audio = Buffer.alloc(500);
    const chunks = chunkAudio(audio, 20, 8000, 1);
    expect(chunks.length).toBe(4);
    expect(chunks[0].length).toBe(160);
    expect(chunks[1].length).toBe(160);
    expect(chunks[2].length).toBe(160);
    expect(chunks[3].length).toBe(20);
  });

  it("empty buffer returns empty array", () => {
    const chunks = chunkAudio(Buffer.alloc(0), 20, 8000, 1);
    expect(chunks.length).toBe(0);
  });
});

describe("reassemble", () => {
  it("reassembled chunks match original buffer", () => {
    const original = Buffer.alloc(500);
    for (let i = 0; i < 500; i++) {
      original[i] = i % 256;
    }
    const chunks = chunkAudio(original, 20, 8000, 1);
    const result = reassemble(chunks);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it("empty chunks array returns empty buffer", () => {
    const result = reassemble([]);
    expect(result.length).toBe(0);
  });

  it("single chunk returns that chunk", () => {
    const chunk = Buffer.from([1, 2, 3, 4]);
    const result = reassemble([chunk]);
    expect(Buffer.compare(result, chunk)).toBe(0);
  });
});
