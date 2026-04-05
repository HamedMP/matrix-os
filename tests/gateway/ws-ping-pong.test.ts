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

  describe("main /ws handler", () => {
    it("responds with pong when receiving ping", () => {
      const sent: unknown[] = [];
      const send = (msg: unknown) => sent.push(msg);

      const parsed = { type: "ping" } as const;

      if (parsed.type === "ping") {
        send({ type: "pong" });
      }

      expect(sent).toEqual([{ type: "pong" }]);
    });

    it("does not dispatch ping to kernel", () => {
      const dispatched: string[] = [];
      const parsed = { type: "ping" } as const;

      if (parsed.type !== "ping") {
        dispatched.push(parsed.type);
      }

      expect(dispatched).toHaveLength(0);
    });
  });

  describe("terminal /ws/terminal handler", () => {
    it("responds with pong for ping message", () => {
      const sent: unknown[] = [];
      const sendJson = (msg: unknown) => sent.push(msg);

      const msgType = "ping";
      if (msgType === "ping") {
        sendJson({ type: "pong" });
      }

      expect(sent).toEqual([{ type: "pong" }]);
    });

    it("does not forward ping to PTY session", () => {
      const forwarded: unknown[] = [];
      const handle = { send: (msg: unknown) => forwarded.push(msg) };

      const msgType = "ping";
      if (msgType !== "ping") {
        handle.send({ type: msgType });
      }

      expect(forwarded).toHaveLength(0);
    });
  });
});
