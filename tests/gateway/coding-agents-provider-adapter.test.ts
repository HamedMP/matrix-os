import { describe, expect, it } from "vitest";
import { parseCodingAgentProviderRunResult } from "../../packages/gateway/src/coding-agents/provider-adapter.js";

const now = "2026-07-10T12:00:00.000Z";

describe("coding agent provider adapter boundary", () => {
  it("parses bounded same-thread events and server-only resume state", () => {
    expect(parseCodingAgentProviderRunResult({
      events: [{
        type: "thread.status",
        eventId: "evt_provider_1",
        threadId: "thread_provider_1",
        occurredAt: now,
        status: "running",
      }],
      resumeState: { conversationId: "provider_conversation_1" },
      outcome: "completed",
    }, "thread_provider_1")).toMatchObject({
      resumeState: { conversationId: "provider_conversation_1" },
      outcome: "completed",
    });
  });

  it("rejects cross-thread events and unknown credential-like fields", () => {
    expect(() => parseCodingAgentProviderRunResult({
      events: [{
        type: "thread.status",
        eventId: "evt_provider_cross_thread",
        threadId: "thread_other",
        occurredAt: now,
        status: "running",
      }],
      outcome: "completed",
    }, "thread_provider_1")).toThrow("Provider emitted event for another thread");

    expect(() => parseCodingAgentProviderRunResult({
      events: [],
      resumeState: {
        conversationId: "provider_conversation_1",
        bearerToken: "unsafe",
      },
      outcome: "completed",
    } as never, "thread_provider_1")).toThrow();
  });

  it("rejects provider-authored user messages so the gateway remains authoritative", () => {
    expect(() => parseCodingAgentProviderRunResult({
      events: [{
        type: "user.message",
        eventId: "evt_provider_user_message",
        threadId: "thread_provider_1",
        occurredAt: now,
        messageId: "msg_provider_user_message",
        text: "Provider-invented user content",
        clientRequestId: "req_provider_user_message",
      }],
      outcome: "completed",
    }, "thread_provider_1")).toThrow("Provider cannot emit user messages");
  });
});
