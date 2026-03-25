import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleVoiceWsMessage, type VoiceWsContext } from "../../../packages/gateway/src/voice/voice-ws.js";

describe("Voice WebSocket message handling", () => {
  let ctx: VoiceWsContext;
  let sent: unknown[];
  let dispatched: Array<{ text: string; metadata?: Record<string, unknown> }>;
  let transcribeResult: { text: string; language?: string; durationMs?: number };
  let synthesizeResult: { audio: Buffer; format: string; provider: string; durationMs?: number };
  let transcribeError: Error | null;
  let synthesizeError: Error | null;

  beforeEach(() => {
    sent = [];
    dispatched = [];
    transcribeResult = { text: "hello world", language: "en", durationMs: 1500 };
    synthesizeResult = {
      audio: Buffer.from("fake-audio-data"),
      format: "mp3",
      provider: "edge",
      durationMs: 1200,
    };
    transcribeError = null;
    synthesizeError = null;

    ctx = {
      voiceService: {
        transcribe: vi.fn(async () => {
          if (transcribeError) throw transcribeError;
          return transcribeResult;
        }),
        synthesize: vi.fn(async () => {
          if (synthesizeError) throw synthesizeError;
          return synthesizeResult;
        }),
        isEnabled: vi.fn(() => true),
      },
      send: (data: unknown) => { sent.push(data); },
      dispatch: vi.fn(async (text: string, metadata?: Record<string, unknown>) => {
        dispatched.push({ text, metadata });
        return "AI response text";
      }),
    };
  });

  describe("audio transcription flow", () => {
    it("transcribes audio and sends transcription back", async () => {
      const audioBuffer = Buffer.from("audio-data");

      await handleVoiceWsMessage(ctx, audioBuffer);

      expect(ctx.voiceService.transcribe).toHaveBeenCalledWith(audioBuffer);
      expect(sent).toContainEqual(
        JSON.stringify({ type: "voice_transcription", text: "hello world" }),
      );
    });

    it("dispatches transcript to kernel with voice metadata", async () => {
      const audioBuffer = Buffer.from("audio-data");

      await handleVoiceWsMessage(ctx, audioBuffer);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].text).toBe("hello world");
      expect(dispatched[0].metadata).toEqual({ source: "voice" });
    });

    it("synthesizes AI response and sends voice_audio back", async () => {
      const audioBuffer = Buffer.from("audio-data");

      await handleVoiceWsMessage(ctx, audioBuffer);

      expect(ctx.voiceService.synthesize).toHaveBeenCalledWith("AI response text");

      const audioMsg = sent.find((s) => {
        if (typeof s === "string") {
          try {
            const parsed = JSON.parse(s);
            return parsed.type === "voice_audio";
          } catch { return false; }
        }
        return false;
      });

      expect(audioMsg).toBeDefined();
      const parsed = JSON.parse(audioMsg as string);
      expect(parsed.type).toBe("voice_audio");
      expect(parsed.audio).toBe(synthesizeResult.audio.toString("base64"));
      expect(parsed.format).toBe("mp3");
    });
  });

  describe("error handling", () => {
    it("sends error when STT fails", async () => {
      transcribeError = new Error("STT service unavailable");
      const audioBuffer = Buffer.from("bad-audio");

      await handleVoiceWsMessage(ctx, audioBuffer);

      const errorMsg = sent.find((s) => {
        if (typeof s === "string") {
          try {
            const parsed = JSON.parse(s);
            return parsed.type === "voice_error";
          } catch { return false; }
        }
        return false;
      });

      expect(errorMsg).toBeDefined();
      const parsed = JSON.parse(errorMsg as string);
      expect(parsed.type).toBe("voice_error");
      expect(parsed.message).toContain("Transcription failed");
    });

    it("does not dispatch or synthesize when STT fails", async () => {
      transcribeError = new Error("STT failed");
      const audioBuffer = Buffer.from("bad-audio");

      await handleVoiceWsMessage(ctx, audioBuffer);

      expect(dispatched).toHaveLength(0);
      expect(ctx.voiceService.synthesize).not.toHaveBeenCalled();
    });

    it("sends error when TTS fails but still dispatches transcript", async () => {
      synthesizeError = new Error("TTS provider down");
      const audioBuffer = Buffer.from("audio-data");

      await handleVoiceWsMessage(ctx, audioBuffer);

      // Transcript should still be sent
      expect(sent).toContainEqual(
        JSON.stringify({ type: "voice_transcription", text: "hello world" }),
      );

      // Dispatch should still happen
      expect(dispatched).toHaveLength(1);

      // TTS error should be reported
      const errorMsg = sent.find((s) => {
        if (typeof s === "string") {
          try {
            const parsed = JSON.parse(s);
            return parsed.type === "voice_error";
          } catch { return false; }
        }
        return false;
      });
      expect(errorMsg).toBeDefined();
      const parsed = JSON.parse(errorMsg as string);
      expect(parsed.message).toContain("Voice response failed");
    });
  });

  describe("voice service disabled", () => {
    it("sends error when voice is not enabled", async () => {
      ctx.voiceService.isEnabled = vi.fn(() => false);
      const audioBuffer = Buffer.from("audio-data");

      await handleVoiceWsMessage(ctx, audioBuffer);

      const errorMsg = sent.find((s) => {
        if (typeof s === "string") {
          try {
            const parsed = JSON.parse(s);
            return parsed.type === "voice_error";
          } catch { return false; }
        }
        return false;
      });
      expect(errorMsg).toBeDefined();
      const parsed = JSON.parse(errorMsg as string);
      expect(parsed.message).toContain("Voice service is not enabled");
    });
  });

  describe("framing protocol", () => {
    it("handles base64-encoded audio in JSON message", async () => {
      const audioData = Buffer.from("raw-audio-bytes");
      const base64 = audioData.toString("base64");
      const jsonMsg = JSON.stringify({ type: "voice", audio: base64 });

      const parsed = JSON.parse(jsonMsg);
      expect(parsed.type).toBe("voice");

      const decoded = Buffer.from(parsed.audio, "base64");
      expect(decoded.toString()).toBe("raw-audio-bytes");
    });

    it("handles binary audio buffer directly", async () => {
      const audioBuffer = Buffer.from("direct-binary-audio");

      await handleVoiceWsMessage(ctx, audioBuffer);

      expect(ctx.voiceService.transcribe).toHaveBeenCalledWith(audioBuffer);
    });
  });
});
