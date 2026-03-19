import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleCallTool,
  handleSpeakTool,
  handleTranscribeTool,
  type VoiceToolDeps,
} from "../../packages/kernel/src/voice-tools.js";

function createMockDeps(overrides: Partial<VoiceToolDeps> = {}): VoiceToolDeps {
  return {
    voiceEnabled: true,
    homePath: "/tmp/test-home",
    callManager: {
      initiateCall: vi.fn().mockResolvedValue({
        callId: "call-123",
        state: "initiated",
        providerCallId: "prov-123",
      }),
      getCall: vi.fn().mockReturnValue({
        callId: "call-123",
        state: "active",
        from: "+1111111111",
        to: "+2222222222",
        transcript: [],
      }),
      endCall: vi.fn().mockResolvedValue(undefined),
      speak: vi.fn().mockResolvedValue(undefined),
      getActiveCalls: vi.fn().mockReturnValue([]),
    } as VoiceToolDeps["callManager"],
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from("fake-audio"),
      format: "mp3" as const,
      sampleRate: 24000,
      durationMs: 1500,
      provider: "edge",
    }),
    transcribe: vi.fn().mockResolvedValue({
      text: "hello world",
      language: "en",
      durationMs: 2000,
    }),
    ...overrides,
  };
}

describe("Voice IPC Tools", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("handleSpeakTool()", () => {
    it("returns audioUrl and durationMs", async () => {
      const deps = createMockDeps();
      const result = await handleSpeakTool(deps, { text: "Hello" });

      expect(result.text).toContain("Audio saved");
      expect(result.text).toContain("1500");
      expect(deps.synthesize).toHaveBeenCalledWith("Hello", undefined);
    });

    it("forces specific provider", async () => {
      const deps = createMockDeps();
      await handleSpeakTool(deps, { text: "Hello", provider: "edge" });

      expect(deps.synthesize).toHaveBeenCalledWith("Hello", {
        voice: undefined,
        model: undefined,
        format: undefined,
      });
    });

    it("with empty text returns error", async () => {
      const deps = createMockDeps();
      const result = await handleSpeakTool(deps, { text: "" });

      expect(result.text).toContain("required");
    });

    it("voice disabled returns error", async () => {
      const deps = createMockDeps({ voiceEnabled: false });
      const result = await handleSpeakTool(deps, { text: "Hello" });

      expect(result.text).toContain("not enabled");
    });
  });

  describe("handleTranscribeTool()", () => {
    it("returns text and language", async () => {
      const deps = createMockDeps();
      const result = await handleTranscribeTool(deps, {
        filePath: "/tmp/test.webm",
        audioBuffer: Buffer.from("fake"),
      });

      expect(result.text).toContain("hello world");
      expect(result.text).toContain("en");
    });

    it("voice disabled returns error", async () => {
      const deps = createMockDeps({ voiceEnabled: false });
      const result = await handleTranscribeTool(deps, {
        filePath: "/tmp/test.webm",
        audioBuffer: Buffer.from("fake"),
      });

      expect(result.text).toContain("not enabled");
    });
  });

  describe("handleCallTool()", () => {
    it("action=initiate returns callId", async () => {
      process.env.TWILIO_FROM_NUMBER = "+15551234567";
      process.env.MATRIX_HANDLE = "testuser";
      const deps = createMockDeps();
      const result = await handleCallTool(deps, {
        action: "initiate",
        to: "+1234567890",
      });

      expect(result.text).toContain("call-123");
      expect(deps.callManager!.initiateCall).toHaveBeenCalled();
    });

    it("action=initiate without TWILIO_FROM_NUMBER returns config error", async () => {
      delete process.env.TWILIO_FROM_NUMBER;
      const deps = createMockDeps();
      const result = await handleCallTool(deps, {
        action: "initiate",
        to: "+1234567890",
      });

      expect(result.text).toContain("not configured");
    });

    it("action=initiate without 'to' returns error", async () => {
      process.env.TWILIO_FROM_NUMBER = "+15551234567";
      process.env.MATRIX_HANDLE = "testuser";
      const deps = createMockDeps();
      const result = await handleCallTool(deps, {
        action: "initiate",
      });

      expect(result.text).toContain("required");
    });

    it("action=speak with callId and message", async () => {
      const deps = createMockDeps();
      const result = await handleCallTool(deps, {
        action: "speak",
        callId: "call-123",
        message: "Hello there",
      });

      expect(result.text).toContain("Spoke");
      expect(deps.callManager!.speak).toHaveBeenCalledWith(
        "call-123",
        "Hello there",
      );
    });

    it("action=hangup with callId", async () => {
      const deps = createMockDeps();
      const result = await handleCallTool(deps, {
        action: "hangup",
        callId: "call-123",
      });

      expect(result.text).toContain("Ended");
      expect(deps.callManager!.endCall).toHaveBeenCalledWith("call-123");
    });

    it("action=status with callId", async () => {
      const deps = createMockDeps();
      const result = await handleCallTool(deps, {
        action: "status",
        callId: "call-123",
      });

      expect(result.text).toContain("active");
      expect(deps.callManager!.getCall).toHaveBeenCalledWith("call-123");
    });

    it("voice disabled returns error", async () => {
      const deps = createMockDeps({ voiceEnabled: false });
      const result = await handleCallTool(deps, {
        action: "initiate",
        to: "+1234567890",
      });

      expect(result.text).toContain("not enabled");
    });

    it("no callManager returns error", async () => {
      const deps = createMockDeps({ callManager: undefined });
      const result = await handleCallTool(deps, {
        action: "initiate",
        to: "+1234567890",
      });

      expect(result.text).toContain("CallManager not available");
    });
  });
});
