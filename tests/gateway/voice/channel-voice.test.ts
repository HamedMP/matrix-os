import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  handleVoiceNote,
  type VoiceNoteResult,
} from "../../../packages/gateway/src/voice/channel-voice.js";
import type { SttProvider } from "../../../packages/gateway/src/voice/stt/base.js";

function createMockStt(
  overrides: Partial<SttProvider> = {},
): SttProvider {
  return {
    name: "mock-stt",
    isAvailable: vi.fn(() => true),
    transcribe: vi.fn().mockResolvedValue({
      text: "Hello from voice",
      language: "en",
      durationMs: 2500,
    }),
    ...overrides,
  };
}

describe("handleVoiceNote", () => {
  let homePath: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "matrixos-voice-test-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(homePath, { recursive: true, force: true });
  });

  it("downloads audio from URL", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt();
    await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/audio.ogg");
  });

  it("saves to ~/data/audio/{channel}-{timestamp}.{ext}", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt();
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(result.filePath).toMatch(/data\/audio\/telegram-\d+\.ogg$/);
    expect(existsSync(result.filePath)).toBe(true);
    expect(readFileSync(result.filePath)).toEqual(audioData);
  });

  it("transcribes audio via SttProvider", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt();
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(stt.transcribe).toHaveBeenCalledWith(audioData);
    expect(result.transcript).toBe("Hello from voice");
  });

  it("returns { filePath, transcript, durationMs }", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt();
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(result.filePath).toBeDefined();
    expect(result.transcript).toBe("Hello from voice");
    expect(result.durationMs).toBe(2500);
    expect(result.error).toBeUndefined();
  });

  it("rejects files > 10MB", async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer.slice(largeBuffer.byteOffset, largeBuffer.byteOffset + largeBuffer.byteLength)),
    });

    const stt = createMockStt();
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(result.transcript).toBeNull();
    expect(result.error).toMatch(/exceeds 10MB limit/);
    expect(result.durationMs).toBe(0);
    expect(stt.transcribe).not.toHaveBeenCalled();
  });

  it("download failure returns error gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const stt = createMockStt();
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/missing.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(result.transcript).toBeNull();
    expect(result.error).toMatch(/Download failed: 404/);
    expect(result.durationMs).toBe(0);
  });

  it("STT failure returns { filePath, transcript: null, error }", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt({
      transcribe: vi.fn().mockRejectedValue(new Error("Whisper API down")),
    });

    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(result.filePath).toBeDefined();
    expect(existsSync(result.filePath)).toBe(true);
    expect(result.transcript).toBeNull();
    expect(result.error).toBe("Whisper API down");
    expect(result.durationMs).toBe(0);
  });

  it("creates ~/data/audio/ directory if not exists", async () => {
    const audioDir = join(homePath, "data", "audio");
    expect(existsSync(audioDir)).toBe(false);

    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt();
    await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(existsSync(audioDir)).toBe(true);
  });

  it("returns STT not available error when stt is null", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt: null,
    });

    expect(result.filePath).toBeDefined();
    expect(existsSync(result.filePath)).toBe(true);
    expect(result.transcript).toBeNull();
    expect(result.error).toBe("STT not available");
  });

  it("returns STT not available error when stt.isAvailable() is false", async () => {
    const audioData = Buffer.from("fake-ogg-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt({ isAvailable: vi.fn(() => false) });
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.ogg",
      channel: "telegram",
      homePath,
      stt,
    });

    expect(result.transcript).toBeNull();
    expect(result.error).toBe("STT not available");
  });

  it("uses custom extension when provided", async () => {
    const audioData = Buffer.from("fake-mp3-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
    });

    const stt = createMockStt();
    const result = await handleVoiceNote({
      audioUrl: "https://example.com/audio.mp3",
      channel: "discord",
      homePath,
      stt,
      extension: "mp3",
    });

    expect(result.filePath).toMatch(/discord-\d+\.mp3$/);
  });
});
