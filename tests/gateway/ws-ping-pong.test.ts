import { describe, it, expect } from "vitest";
import { ClientMessageSchema } from "../../packages/gateway/src/session-registry.js";

describe("WebSocket ping/pong protocol", () => {
  describe("ClientMessageSchema", () => {
    it("accepts ping message", () => {
      const result = ClientMessageSchema.safeParse({ type: "ping" });
      expect(result.success).toBe(true);
    });

    it("rejects unknown message types", () => {
      const result = ClientMessageSchema.safeParse({ type: "unknown" });
      expect(result.success).toBe(false);
    });
  });
});
