import { describe, expect, it } from "vitest";
import { MainWsClientMessageSchema } from "../../packages/gateway/src/ws-message-schema.js";

describe("MainWsClientMessageSchema", () => {
  it("accepts valid chat messages", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "message",
      text: "hello",
      displayText: "visible hello",
      requestId: "req-1",
    });

    expect(result.success).toBe(true);
  });

  it.each(["claude", "codex", "pi"])("accepts the %s Global Chat provider", (providerId) => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "message",
      text: "hello",
      requestId: "req-provider",
      providerId,
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "message") {
      expect(result.data.providerId).toBe(providerId);
    }
  });

  it.each(["hermes", "openai", "unknown"])(
    "rejects the unsupported %s Global Chat provider",
    (providerId) => {
      expect(MainWsClientMessageSchema.safeParse({
        type: "message",
        text: "hello",
        providerId,
      }).success).toBe(false);
    },
  );

  it("accepts allowlisted per-message model and effort overrides", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "message",
      text: "hello",
      model: "claude-sonnet-4-5",
      effort: "max",
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "message") {
      expect(result.data.model).toBe("claude-sonnet-4-5");
      expect(result.data.effort).toBe("max");
    }
  });

  it.each(["workingDirectory", "path", "localPath"])(
    "rejects the client-controlled %s path field",
    (field) => {
      const result = MainWsClientMessageSchema.safeParse({
        type: "message",
        text: "hello",
        [field]: "/private/project",
      });

      expect(result.success).toBe(false);
    },
  );

  it.each([
    ["model", "not-an-allowlisted-model"],
    ["effort", "extreme"],
  ])("rejects an unsupported %s override", (key, value) => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "message",
      text: "hello",
      [key]: value,
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed switch_session payloads", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "switch_session",
      sessionId: "",
    });

    expect(result.success).toBe(false);
  });

  it("accepts an explicit completed-run replay policy when switching sessions", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "switch_session",
      sessionId: "conversation-one",
      replayCompleted: false,
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "switch_session") {
      expect(result.data.replayCompleted).toBe(false);
    }
  });

  it("rejects non-boolean completed-run replay policies", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "switch_session",
      sessionId: "conversation-one",
      replayCompleted: "false",
    });

    expect(result.success).toBe(false);
  });
});
