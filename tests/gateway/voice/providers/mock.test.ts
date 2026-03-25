import { describe, it, expect, beforeEach } from "vitest";
import { MockProvider } from "../../../../packages/gateway/src/voice/providers/mock.js";
import type { WebhookContext } from "../../../../packages/gateway/src/voice/types.js";

const dummyWebhookCtx: WebhookContext = {
  method: "POST",
  url: "https://example.com/webhook",
  headers: {},
  rawBody: "",
};

describe("MockProvider", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it("has name 'mock'", () => {
    expect(provider.name).toBe("mock");
  });

  describe("initiateCall()", () => {
    it("returns result with mock callId", async () => {
      const result = await provider.initiateCall({
        callId: "call-1",
        from: "+1111111111",
        to: "+2222222222",
        webhookUrl: "https://example.com/hook",
      });

      expect(result.providerCallId).toBeDefined();
      expect(result.providerCallId.startsWith("mock-")).toBe(true);
      expect(result.status).toBe("initiated");
    });

    it("records the call in history", async () => {
      await provider.initiateCall({
        callId: "call-1",
        from: "+1111111111",
        to: "+2222222222",
        webhookUrl: "https://example.com/hook",
      });

      expect(provider.callHistory.length).toBe(1);
      expect(provider.callHistory[0]!.method).toBe("initiateCall");
    });
  });

  describe("playTts()", () => {
    it("records the call", async () => {
      await provider.playTts({
        callId: "call-1",
        providerCallId: "mock-1",
        text: "Hello there",
      });

      expect(provider.callHistory.length).toBe(1);
      expect(provider.callHistory[0]!.method).toBe("playTts");
      expect(provider.callHistory[0]!.args.text).toBe("Hello there");
    });
  });

  describe("startListening / stopListening", () => {
    it("records startListening call", async () => {
      await provider.startListening({
        callId: "call-1",
        providerCallId: "mock-1",
      });

      expect(provider.callHistory.length).toBe(1);
      expect(provider.callHistory[0]!.method).toBe("startListening");
    });

    it("records stopListening call", async () => {
      await provider.stopListening({
        callId: "call-1",
        providerCallId: "mock-1",
      });

      expect(provider.callHistory.length).toBe(1);
      expect(provider.callHistory[0]!.method).toBe("stopListening");
    });
  });

  describe("hangupCall()", () => {
    it("records the call", async () => {
      await provider.hangupCall({
        callId: "call-1",
        providerCallId: "mock-1",
        reason: "hangup-bot",
      });

      expect(provider.callHistory.length).toBe(1);
      expect(provider.callHistory[0]!.method).toBe("hangupCall");
    });
  });

  describe("getCallStatus()", () => {
    it("returns configured state", async () => {
      const result = await provider.getCallStatus({
        providerCallId: "mock-1",
      });

      expect(result.status).toBe("active");
      expect(result.isTerminal).toBe(false);
    });

    it("uses custom status from constructor", async () => {
      const customProvider = new MockProvider({
        callStatus: { status: "completed", isTerminal: true },
      });

      const result = await customProvider.getCallStatus({
        providerCallId: "mock-1",
      });

      expect(result.status).toBe("completed");
      expect(result.isTerminal).toBe(true);
    });
  });

  describe("verifyWebhook()", () => {
    it("always returns { ok: true }", () => {
      const result = provider.verifyWebhook(dummyWebhookCtx);
      expect(result.ok).toBe(true);
    });
  });

  describe("parseWebhookEvent()", () => {
    it("returns injected events", () => {
      const event = {
        id: "evt-1",
        callId: "call-1",
        timestamp: Date.now(),
        type: "call.ringing" as const,
      };

      const customProvider = new MockProvider({
        webhookEvents: [event],
      });

      const result = customProvider.parseWebhookEvent(dummyWebhookCtx);
      expect(result.events.length).toBe(1);
      expect(result.events[0]!.type).toBe("call.ringing");
    });

    it("returns empty events by default", () => {
      const result = provider.parseWebhookEvent(dummyWebhookCtx);
      expect(result.events).toEqual([]);
    });
  });

  describe("callHistory", () => {
    it("tracks all method invocations in order", async () => {
      await provider.initiateCall({
        callId: "call-1",
        from: "+1111111111",
        to: "+2222222222",
        webhookUrl: "https://example.com/hook",
      });
      await provider.playTts({
        callId: "call-1",
        providerCallId: "mock-1",
        text: "Hello",
      });
      await provider.hangupCall({
        callId: "call-1",
        providerCallId: "mock-1",
        reason: "hangup-bot",
      });

      expect(provider.callHistory.length).toBe(3);
      expect(provider.callHistory.map((h) => h.method)).toEqual([
        "initiateCall",
        "playTts",
        "hangupCall",
      ]);
    });
  });
});
