import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { VoiceService } from "../../../packages/gateway/src/voice/index.js";
import type { VoiceServiceConfig } from "../../../packages/gateway/src/voice/index.js";

describe("VoiceService", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("create()", () => {
    it("initializes TTS and STT services with default config", () => {
      const service = VoiceService.create();

      expect(service).toBeDefined();
      expect(service.isEnabled()).toBe(true);
      expect(service.tts).not.toBeNull();
      expect(service.stt).toBeNull(); // no OPENAI_API_KEY
    });

    it("with no API keys: TTS fallback to EdgeTTS, STT unavailable", () => {
      const service = VoiceService.create();

      expect(service.tts).not.toBeNull();
      expect(service.tts!.isAvailable()).toBe(true); // EdgeTTS always available

      const status = service.tts!.getStatus();
      const edgeStatus = status.find((s) => s.name === "edge");
      expect(edgeStatus).toBeDefined();
      expect(edgeStatus!.available).toBe(true);

      const elevenStatus = status.find((s) => s.name === "elevenlabs");
      expect(elevenStatus).toBeDefined();
      expect(elevenStatus!.available).toBe(false);

      const openaiStatus = status.find((s) => s.name === "openai");
      expect(openaiStatus).toBeDefined();
      expect(openaiStatus!.available).toBe(false);

      expect(service.stt).toBeNull();
    });

    it("with ELEVENLABS_API_KEY: ElevenLabs is first in chain", () => {
      const service = VoiceService.create({
        tts: {
          elevenlabs: { apiKey: "el-test-key" },
        },
      });

      const status = service.tts!.getStatus();
      expect(status[0]!.name).toBe("elevenlabs");
      expect(status[0]!.available).toBe(true);
    });

    it("with OPENAI_API_KEY: OpenAI TTS available, Whisper STT available", () => {
      const service = VoiceService.create({
        tts: {
          openai: { apiKey: "sk-test" },
        },
        stt: {
          openai: { apiKey: "sk-test" },
        },
      });

      const status = service.tts!.getStatus();
      const openaiStatus = status.find((s) => s.name === "openai");
      expect(openaiStatus).toBeDefined();
      expect(openaiStatus!.available).toBe(true);

      expect(service.stt).not.toBeNull();
      expect(service.stt!.isAvailable()).toBe(true);
      expect(service.stt!.name).toBe("whisper");
    });

    it("with voice disabled in config: tts and stt are null", () => {
      const service = VoiceService.create({ enabled: false });

      expect(service.isEnabled()).toBe(false);
      expect(service.tts).toBeNull();
      expect(service.stt).toBeNull();
    });
  });

  describe("health()", () => {
    it("returns correct status object with no API keys", () => {
      const service = VoiceService.create();
      const health = service.health();

      expect(health.enabled).toBe(true);
      expect(health.tts.available).toBe(true); // EdgeTTS
      expect(health.tts.providers).toContain("edge");
      expect(health.tts.providers).not.toContain("elevenlabs");
      expect(health.tts.providers).not.toContain("openai");
      expect(health.stt.available).toBe(false);
      expect(health.stt.provider).toBeNull();
    });

    it("returns correct status when disabled", () => {
      const service = VoiceService.create({ enabled: false });
      const health = service.health();

      expect(health.enabled).toBe(false);
      expect(health.tts.available).toBe(false);
      expect(health.tts.providers).toEqual([]);
      expect(health.stt.available).toBe(false);
      expect(health.stt.provider).toBeNull();
    });

    it("returns correct status with all providers configured", () => {
      const service = VoiceService.create({
        tts: {
          elevenlabs: { apiKey: "el-key" },
          openai: { apiKey: "sk-key" },
        },
        stt: {
          openai: { apiKey: "sk-key" },
        },
      });
      const health = service.health();

      expect(health.enabled).toBe(true);
      expect(health.tts.available).toBe(true);
      expect(health.tts.providers).toContain("elevenlabs");
      expect(health.tts.providers).toContain("openai");
      expect(health.tts.providers).toContain("edge");
      expect(health.stt.available).toBe(true);
      expect(health.stt.provider).toBe("whisper");
    });
  });

  describe("synthesize()", () => {
    it("delegates to fallback chain", async () => {
      const fakeAudio = Buffer.from("edge-audio-data");
      const mockTtsPromise = vi.fn().mockImplementation(async (_text: string, path: string) => {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, fakeAudio);
      });

      vi.doMock("node-edge-tts", () => ({
        EdgeTTS: class {
          ttsPromise = mockTtsPromise;
        },
      }));

      const { VoiceService: MockedVoiceService } = await import(
        "../../../packages/gateway/src/voice/index.js"
      );

      const service = MockedVoiceService.create();
      const result = await service.synthesize("hello");

      expect(result).toBeDefined();
      expect(result.provider).toBe("edge");
      expect(result.audio).toBeInstanceOf(Buffer);

      vi.doUnmock("node-edge-tts");
    });

    it("throws when TTS is disabled", async () => {
      const service = VoiceService.create({ enabled: false });

      await expect(service.synthesize("hello")).rejects.toThrow(
        /Voice TTS is not enabled/,
      );
    });
  });

  describe("transcribe()", () => {
    it("delegates to whisper provider", async () => {
      const audioData = Buffer.from("fake-audio");
      const mockResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            text: "hello world",
            language: "en",
            duration: 1.5,
          }),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      try {
        const service = VoiceService.create({
          stt: { openai: { apiKey: "sk-test" } },
        });

        const result = await service.transcribe(audioData);

        expect(result).toBeDefined();
        expect(result.text).toBe("hello world");
        expect(result.language).toBe("en");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws when STT is not available", async () => {
      const service = VoiceService.create();
      const audioData = Buffer.from("fake-audio");

      await expect(service.transcribe(audioData)).rejects.toThrow(
        /Voice STT is not available/,
      );
    });
  });

  describe("stop()", () => {
    it("cleans up resources without error", () => {
      const service = VoiceService.create();
      expect(() => service.stop()).not.toThrow();
    });

    it("works on disabled service", () => {
      const service = VoiceService.create({ enabled: false });
      expect(() => service.stop()).not.toThrow();
    });
  });
});
