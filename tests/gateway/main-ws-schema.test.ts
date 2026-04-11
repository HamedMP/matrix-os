import { describe, expect, it } from "vitest";
import { MainWsClientMessageSchema } from "../../packages/gateway/src/ws-message-schema.js";

describe("MainWsClientMessageSchema", () => {
  it("accepts valid chat messages", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "message",
      text: "hello",
      requestId: "req-1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed switch_session payloads", () => {
    const result = MainWsClientMessageSchema.safeParse({
      type: "switch_session",
      sessionId: "",
    });

    expect(result.success).toBe(false);
  });
});
