import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createVoiceService,
  type VoiceService,
  type VoiceConfig,
} from "../../packages/gateway/src/voice.js";

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: true,
  elevenlabsKey: "test-key",
  voiceId: "21m00Tcm4TlvDq8ikWAM",
  model: "eleven_turbo_v2_5",
  sttProvider: "elevenlabs",
};

const fakeAudioBuffer = Buffer.from("fake-mp3-audio-data");

describe("Voice Service", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = resolve(mkdtempSync(join(tmpdir(), "voice-")));
    mkdirSync(join(tempHome, "system", "logs"), { recursive: true });
    mkdirSync(join(tempHome, "data", "audio"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("createVoiceService", () => {
    it("initializes with config", () => {
      const service = createVoiceService(DEFAULT_CONFIG, tempHome);
      expect(service).toBeDefined();
      expect(typeof service.textToSpeech).toBe("function");
      expect(typeof service.speechToText).toBe("function");
      expect(typeof service.isConfigured).toBe("function");
    });

    it("reports configured when API key present", () => {
      const service = createVoiceService(DEFAULT_CONFIG, tempHome);
      expect(service.isConfigured()).toBe(true);
    });

    it("reports not configured when no API key", () => {
      const service = createVoiceService({ ...DEFAULT_CONFIG, elevenlabsKey: "" }, tempHome);
      expect(service.isConfigured()).toBe(false);
    });

    it("reports not configured when disabled", () => {
      const service = createVoiceService({ ...DEFAULT_CONFIG, enabled: false }, tempHome);
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe("textToSpeech", () => {
    it("returns audio buffer from API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudioBuffer.buffer),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      const result = await service.textToSpeech("Hello world");

      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.audio.length).toBeGreaterThan(0);
    });

    it("calls ElevenLabs TTS API with correct params", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudioBuffer.buffer),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      await service.textToSpeech("Hello world");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "xi-api-key": "test-key",
          }),
        }),
      );
    });

    it("saves audio to ~/data/audio/ and returns path", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudioBuffer.buffer),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      const result = await service.textToSpeech("Hello world");

      expect(result.localPath).toBeDefined();
      expect(existsSync(result.localPath)).toBe(true);
    });

    it("estimates cost based on character count", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudioBuffer.buffer),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      const result = await service.textToSpeech("Hello world");

      expect(typeof result.cost).toBe("number");
      expect(result.cost).toBeGreaterThan(0);
    });

    it("handles API auth errors", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("Invalid API key"),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      await expect(service.textToSpeech("test")).rejects.toThrow("API key");
    });

    it("handles rate limit errors", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve("Rate limited"),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      await expect(service.textToSpeech("test")).rejects.toThrow("Rate limit");
    });

    it("throws when not configured", async () => {
      const service = createVoiceService({ ...DEFAULT_CONFIG, elevenlabsKey: "" }, tempHome);
      await expect(service.textToSpeech("test")).rejects.toThrow("not configured");
    });

    it("allows custom voice_id override", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudioBuffer.buffer),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      await service.textToSpeech("Hello", { voiceId: "custom-voice" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("custom-voice"),
        expect.any(Object),
      );
    });
  });

  describe("speechToText", () => {
    it("returns transcription from API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: "Hello world", confidence: 0.95 }),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      const result = await service.speechToText(fakeAudioBuffer);

      expect(result.text).toBe("Hello world");
      expect(result.confidence).toBeCloseTo(0.95);
    });

    it("calls ElevenLabs STT API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: "Hello", confidence: 0.9 }),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      await service.speechToText(fakeAudioBuffer);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.elevenlabs.io/v1/speech-to-text"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "xi-api-key": "test-key",
          }),
        }),
      );
    });

    it("estimates cost based on audio duration", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: "Hello", confidence: 0.9 }),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      const result = await service.speechToText(fakeAudioBuffer);

      expect(typeof result.cost).toBe("number");
      expect(result.cost).toBeGreaterThan(0);
    });

    it("handles API errors", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("Server error"),
      });

      const service = createVoiceService(DEFAULT_CONFIG, tempHome, { fetchFn: mockFetch });
      await expect(service.speechToText(fakeAudioBuffer)).rejects.toThrow();
    });

    it("throws when not configured", async () => {
      const service = createVoiceService({ ...DEFAULT_CONFIG, elevenlabsKey: "" }, tempHome);
      await expect(service.speechToText(fakeAudioBuffer)).rejects.toThrow("not configured");
    });
  });
});
