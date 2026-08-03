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
});
