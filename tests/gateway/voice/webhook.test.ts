import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { createWebhookRouter } from "../../../packages/gateway/src/voice/webhook.js";
import { CallManager } from "../../../packages/gateway/src/voice/call-manager.js";
import { MockProvider } from "../../../packages/gateway/src/voice/providers/mock.js";
import type { VoiceCallProvider } from "../../../packages/gateway/src/voice/providers/base.js";
import type { VoiceConfig } from "../../../packages/gateway/src/voice/types.js";

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

describe("Webhook Router", () => {
  let app: Hono;
  let callManager: CallManager;
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider({
      webhookEvents: [
        {
          id: "evt-1",
          callId: "call-1",
          timestamp: Date.now(),
          type: "call.ringing",
        },
      ],
    });

    callManager = new CallManager();
    callManager.initialize(mockProvider, defaultConfig());

    const providers = new Map<string, VoiceCallProvider>();
    providers.set("mock", mockProvider);

    const router = createWebhookRouter({ callManager, providers });
    app = new Hono();
    app.route("/voice/webhook", router);
  });

  it("POST /voice/webhook/:provider routes to the provider", async () => {
    // First initiate a call so the manager has call-1
    vi.spyOn(mockProvider, "initiateCall").mockResolvedValue({
      providerCallId: "prov-call-1",
      status: "initiated",
    });
    await callManager.initiateCall("+1234567890", {
      from: "+10987654321",
      webhookUrl: "https://example.com/webhook",
      mode: "conversation",
    });

    // The call gets a random ID, so let's update the mock events to use it
    const activeCalls = callManager.getActiveCalls();
    const callId = activeCalls[0]!.callId;

    // Reconfigure mock provider with correct callId
    mockProvider = new MockProvider({
      webhookEvents: [
        {
          id: "evt-route-1",
          callId,
          timestamp: Date.now(),
          type: "call.ringing",
        },
      ],
    });

    const providers = new Map<string, VoiceCallProvider>();
    providers.set("mock", mockProvider);
    const router = createWebhookRouter({ callManager, providers });
    app = new Hono();
    app.route("/voice/webhook", router);

    const res = await app.request("/voice/webhook/mock", {
      method: "POST",
      body: "",
    });

    expect(res.status).toBe(200);
  });

  it("POST /voice/webhook/unknown returns 404", async () => {
    const res = await app.request("/voice/webhook/unknown-provider", {
      method: "POST",
      body: "",
    });

    expect(res.status).toBe(404);
  });

  it("invalid signature returns 403", async () => {
    // Create a provider that rejects signatures
    const rejectingProvider = new MockProvider();
    vi.spyOn(rejectingProvider, "verifyWebhook").mockReturnValue({
      ok: false,
      reason: "Invalid signature",
    });

    const providers = new Map<string, VoiceCallProvider>();
    providers.set("rejecting", rejectingProvider);
    const router = createWebhookRouter({ callManager, providers });
    const testApp = new Hono();
    testApp.route("/voice/webhook", router);

    const res = await testApp.request("/voice/webhook/rejecting", {
      method: "POST",
      body: "",
    });

    expect(res.status).toBe(403);
  });

  it("valid event dispatched to CallManager", async () => {
    vi.spyOn(mockProvider, "initiateCall").mockResolvedValue({
      providerCallId: "prov-dispatch",
      status: "initiated",
    });
    await callManager.initiateCall("+1234567890", {
      from: "+10987654321",
      webhookUrl: "https://example.com/webhook",
      mode: "conversation",
    });

    const activeCalls = callManager.getActiveCalls();
    const callId = activeCalls[0]!.callId;

    mockProvider = new MockProvider({
      webhookEvents: [
        {
          id: "evt-dispatch-1",
          callId,
          timestamp: Date.now(),
          type: "call.ringing",
        },
      ],
    });

    const providers = new Map<string, VoiceCallProvider>();
    providers.set("mock", mockProvider);
    const router = createWebhookRouter({ callManager, providers });
    app = new Hono();
    app.route("/voice/webhook", router);

    const processEventSpy = vi.spyOn(callManager, "processEvent");

    await app.request("/voice/webhook/mock", {
      method: "POST",
      body: "",
    });

    expect(processEventSpy).toHaveBeenCalledWith(
      callId,
      expect.objectContaining({ type: "call.ringing" }),
    );
  });

  it("duplicate event ID returns 200 but no reprocessing", async () => {
    vi.spyOn(mockProvider, "initiateCall").mockResolvedValue({
      providerCallId: "prov-dedup",
      status: "initiated",
    });
    await callManager.initiateCall("+1234567890", {
      from: "+10987654321",
      webhookUrl: "https://example.com/webhook",
      mode: "conversation",
    });

    const activeCalls = callManager.getActiveCalls();
    const callId = activeCalls[0]!.callId;

    const eventId = "evt-dedup-1";
    mockProvider = new MockProvider({
      webhookEvents: [
        {
          id: eventId,
          callId,
          timestamp: Date.now(),
          type: "call.ringing",
        },
      ],
    });

    const providers = new Map<string, VoiceCallProvider>();
    providers.set("mock", mockProvider);
    const router = createWebhookRouter({ callManager, providers });
    app = new Hono();
    app.route("/voice/webhook", router);

    // First request
    const res1 = await app.request("/voice/webhook/mock", {
      method: "POST",
      body: "",
    });
    expect(res1.status).toBe(200);

    // Second request with same event ID - should still return 200
    const res2 = await app.request("/voice/webhook/mock", {
      method: "POST",
      body: "",
    });
    expect(res2.status).toBe(200);

    // Call state should only be ringing (not double-processed)
    const call = callManager.getCall(callId);
    expect(call!.state).toBe("ringing");
  });
});
