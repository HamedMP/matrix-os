import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CallManager } from "../../../packages/gateway/src/voice/call-manager.js";
import type { VoiceCallProvider } from "../../../packages/gateway/src/voice/providers/base.js";
import type {
  NormalizedEvent,
  CallRecord,
  VoiceConfig,
} from "../../../packages/gateway/src/voice/types.js";

function createMockProvider(): VoiceCallProvider {
  return {
    name: "mock" as const,
    verifyWebhook: vi.fn().mockReturnValue({ ok: true }),
    parseWebhookEvent: vi.fn().mockReturnValue({ events: [] }),
    initiateCall: vi.fn().mockResolvedValue({
      providerCallId: "prov-123",
      status: "initiated" as const,
    }),
    hangupCall: vi.fn().mockResolvedValue(undefined),
    playTts: vi.fn().mockResolvedValue(undefined),
    startListening: vi.fn().mockResolvedValue(undefined),
    stopListening: vi.fn().mockResolvedValue(undefined),
    getCallStatus: vi.fn().mockResolvedValue({
      status: "active",
      isTerminal: false,
    }),
  };
}

function defaultConfig(): VoiceConfig {
  return {
    enabled: true,
    tts: { provider: "auto" },
    stt: { provider: "whisper" },
    telephony: {
      mode: "managed",
      provider: "mock",
      maxDurationSeconds: 600,
      maxConcurrentCalls: 5,
      silenceTimeoutMs: 30000,
    },
    autoSpeakResponses: false,
  };
}

function makeEvent(
  callId: string,
  type: NormalizedEvent["type"],
  extra: Record<string, unknown> = {},
): NormalizedEvent {
  return {
    id: `evt-${Date.now()}-${Math.random()}`,
    callId,
    timestamp: Date.now(),
    type,
    ...extra,
  } as NormalizedEvent;
}

describe("CallManager", () => {
  let manager: CallManager;
  let provider: VoiceCallProvider;
  let config: VoiceConfig;

  beforeEach(() => {
    provider = createMockProvider();
    config = defaultConfig();
    manager = new CallManager();
    manager.initialize(provider, config);
  });

  afterEach(() => {
    manager.destroy();
  });

  describe("initiateCall()", () => {
    it("creates CallRecord in 'initiated' state", async () => {
      const result = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      expect(result.callId).toBeDefined();
      expect(result.state).toBe("initiated");
      expect(result.providerCallId).toBe("prov-123");
    });

    it("stores the call so getCall() can retrieve it", async () => {
      const result = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      const call = manager.getCall(result.callId);
      expect(call).toBeDefined();
      expect(call!.callId).toBe(result.callId);
      expect(call!.to).toBe("+1234567890");
      expect(call!.from).toBe("+10987654321");
      expect(call!.direction).toBe("outbound");
      expect(call!.mode).toBe("conversation");
    });

    it("enforces max concurrent calls", async () => {
      config.telephony.maxConcurrentCalls = 2;
      manager.initialize(provider, config);

      await manager.initiateCall("+11111111111", {
        from: "+10000000000",
        webhookUrl: "https://example.com/webhook",
        mode: "notify",
      });
      await manager.initiateCall("+12222222222", {
        from: "+10000000000",
        webhookUrl: "https://example.com/webhook",
        mode: "notify",
      });

      await expect(
        manager.initiateCall("+13333333333", {
          from: "+10000000000",
          webhookUrl: "https://example.com/webhook",
          mode: "notify",
        }),
      ).rejects.toThrow(/max concurrent/i);
    });
  });

  describe("processEvent()", () => {
    it("transitions initiated -> ringing", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));

      const call = manager.getCall(callId);
      expect(call!.state).toBe("ringing");
    });

    it("transitions ringing -> answered -> active", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));

      const call = manager.getCall(callId);
      expect(call!.state).toBe("answered");
      expect(call!.answeredAt).toBeDefined();
    });

    it("transitions any -> completed on call.ended", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(
        callId,
        makeEvent(callId, "call.ended", { reason: "completed" }),
      );

      const call = manager.getCall(callId);
      expect(call!.state).toBe("completed");
      expect(call!.endedAt).toBeDefined();
      expect(call!.endReason).toBe("completed");
    });

    it("throws on invalid transition (e.g., initiated -> speaking)", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      expect(() =>
        manager.processEvent(
          callId,
          makeEvent(callId, "call.speaking", { text: "Hello" }),
        ),
      ).toThrow(/invalid transition/i);
    });

    it("throws for unknown callId", () => {
      expect(() =>
        manager.processEvent(
          "unknown-call",
          makeEvent("unknown-call", "call.ringing"),
        ),
      ).toThrow(/not found/i);
    });

    it("ignores duplicate event IDs (idempotent)", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      const event = makeEvent(callId, "call.ringing");
      manager.processEvent(callId, event);
      // Processing the same event again should not throw
      manager.processEvent(callId, event);

      const call = manager.getCall(callId);
      expect(call!.state).toBe("ringing");
      expect(call!.processedEventIds.filter((id) => id === event.id).length).toBe(1);
    });
  });

  describe("getActiveCalls()", () => {
    it("returns all non-terminal calls", async () => {
      const { callId: id1 } = await manager.initiateCall("+11111111111", {
        from: "+10000000000",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });
      const { callId: id2 } = await manager.initiateCall("+12222222222", {
        from: "+10000000000",
        webhookUrl: "https://example.com/webhook",
        mode: "notify",
      });

      // End the first call
      manager.processEvent(
        id1,
        makeEvent(id1, "call.ended", { reason: "completed" }),
      );

      const active = manager.getActiveCalls();
      expect(active.length).toBe(1);
      expect(active[0]!.callId).toBe(id2);
    });
  });

  describe("endCall()", () => {
    it("calls provider.hangupCall() and transitions to hangup-bot", async () => {
      const { callId, providerCallId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      await manager.endCall(callId);

      expect(provider.hangupCall).toHaveBeenCalledWith(
        expect.objectContaining({
          callId,
          providerCallId,
          reason: "hangup-bot",
        }),
      );

      const call = manager.getCall(callId);
      expect(call!.state).toBe("hangup-bot");
      expect(call!.endedAt).toBeDefined();
    });
  });

  describe("provider call ID mapping", () => {
    it("looks up call by providerCallId", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      const found = manager.getCallByProviderCallId("prov-123");
      expect(found).toBeDefined();
      expect(found!.callId).toBe(callId);
    });

    it("returns undefined for unknown providerCallId", () => {
      const found = manager.getCallByProviderCallId("unknown-prov");
      expect(found).toBeUndefined();
    });
  });

  describe("transcript accumulation", () => {
    it("accumulates bot entries on speaking events", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));
      manager.processEvent(callId, makeEvent(callId, "call.active"));
      manager.processEvent(
        callId,
        makeEvent(callId, "call.speaking", { text: "Hello there" }),
      );

      const call = manager.getCall(callId);
      expect(call!.transcript.length).toBe(1);
      expect(call!.transcript[0]!.speaker).toBe("bot");
      expect(call!.transcript[0]!.text).toBe("Hello there");
    });

    it("accumulates user entries on speech events", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));
      manager.processEvent(callId, makeEvent(callId, "call.active"));
      manager.processEvent(
        callId,
        makeEvent(callId, "call.speaking", { text: "Hello" }),
      );
      manager.processEvent(
        callId,
        makeEvent(callId, "call.speech", {
          transcript: "Hi there",
          isFinal: true,
          confidence: 0.9,
        }),
      );

      const call = manager.getCall(callId);
      expect(call!.transcript.length).toBe(2);
      expect(call!.transcript[1]!.speaker).toBe("user");
      expect(call!.transcript[1]!.text).toBe("Hi there");
    });
  });

  describe("conversation mode", () => {
    it("calls responseCallback on call.speech event", async () => {
      const onResponse = vi.fn().mockResolvedValue("I heard you");

      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
        onResponse,
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));
      manager.processEvent(callId, makeEvent(callId, "call.active"));
      manager.processEvent(
        callId,
        makeEvent(callId, "call.speaking", { text: "Hello" }),
      );

      manager.processEvent(
        callId,
        makeEvent(callId, "call.speech", {
          transcript: "What time is it?",
          isFinal: true,
          confidence: 0.95,
        }),
      );

      // onResponse is called asynchronously
      await vi.waitFor(() => {
        expect(onResponse).toHaveBeenCalledWith(
          callId,
          "What time is it?",
          expect.any(Array),
        );
      });
    });
  });

  describe("notify mode", () => {
    it("speaks greeting on answered then schedules hangup", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "notify",
        greeting: "Your delivery arrives in 5 minutes.",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));

      // In notify mode, after answered -> active, the greeting should be played
      // Give async side effects time to fire
      await vi.waitFor(() => {
        expect(provider.playTts).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "Your delivery arrives in 5 minutes.",
          }),
        );
      });
    });
  });

  describe("speak()", () => {
    it("calls provider.playTts() with the text", async () => {
      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));
      manager.processEvent(callId, makeEvent(callId, "call.active"));

      await manager.speak(callId, "How can I help you?");

      expect(provider.playTts).toHaveBeenCalledWith(
        expect.objectContaining({
          callId,
          providerCallId: "prov-123",
          text: "How can I help you?",
        }),
      );
    });
  });

  describe("timers", () => {
    it("auto-ends call after maxDuration", async () => {
      vi.useFakeTimers();
      config.telephony.maxDurationSeconds = 10;
      manager = new CallManager();
      manager.initialize(provider, config);

      const { callId } = await manager.initiateCall("+1234567890", {
        from: "+10987654321",
        webhookUrl: "https://example.com/webhook",
        mode: "conversation",
      });

      manager.processEvent(callId, makeEvent(callId, "call.ringing"));
      manager.processEvent(callId, makeEvent(callId, "call.answered"));
      manager.processEvent(callId, makeEvent(callId, "call.active"));

      vi.advanceTimersByTime(10_000);

      await vi.waitFor(() => {
        const call = manager.getCall(callId);
        expect(call!.state).toBe("timeout");
      });

      vi.useRealTimers();
    });
  });
});
