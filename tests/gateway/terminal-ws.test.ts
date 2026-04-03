import { describe, it, expect } from "vitest";
import {
  ClientMessageSchema,
  AttachNewSchema,
  AttachExistingSchema,
  InputSchema,
  ResizeSchema,
  DetachSchema,
} from "../../packages/gateway/src/session-registry.js";

describe("Terminal WebSocket Protocol — Zod Schemas", () => {
  describe("AttachNewSchema", () => {
    it("accepts valid attach-new message", () => {
      const msg = { type: "attach", cwd: "/home/matrixos/home/projects/myapp" };
      expect(AttachNewSchema.parse(msg)).toEqual(msg);
    });

    it("accepts attach-new with optional shell", () => {
      const msg = { type: "attach", cwd: "/home", shell: "/bin/zsh" };
      expect(AttachNewSchema.parse(msg)).toEqual(msg);
    });

    it("rejects empty cwd", () => {
      expect(() => AttachNewSchema.parse({ type: "attach", cwd: "" })).toThrow();
    });

    it("rejects cwd exceeding 4096 chars", () => {
      expect(() => AttachNewSchema.parse({ type: "attach", cwd: "a".repeat(4097) })).toThrow();
    });
  });

  describe("AttachExistingSchema", () => {
    it("accepts valid attach-existing message", () => {
      const msg = { type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000" };
      expect(AttachExistingSchema.parse(msg)).toEqual(msg);
    });

    it("accepts attach-existing with fromSeq", () => {
      const msg = { type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000", fromSeq: 42 };
      expect(AttachExistingSchema.parse(msg)).toEqual(msg);
    });

    it("rejects invalid UUID", () => {
      expect(() => AttachExistingSchema.parse({ type: "attach", sessionId: "not-a-uuid" })).toThrow();
    });

    it("rejects negative fromSeq", () => {
      expect(() =>
        AttachExistingSchema.parse({ type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000", fromSeq: -1 }),
      ).toThrow();
    });

    it("accepts fromSeq of 0", () => {
      const msg = { type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000", fromSeq: 0 };
      expect(AttachExistingSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("InputSchema", () => {
    it("accepts valid input", () => {
      const msg = { type: "input", data: "ls -la\r" };
      expect(InputSchema.parse(msg)).toEqual(msg);
    });

    it("rejects data exceeding 64KB", () => {
      expect(() => InputSchema.parse({ type: "input", data: "x".repeat(65537) })).toThrow();
    });

    it("accepts empty string data", () => {
      const msg = { type: "input", data: "" };
      expect(InputSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("ResizeSchema", () => {
    it("accepts valid resize", () => {
      const msg = { type: "resize", cols: 120, rows: 40 };
      expect(ResizeSchema.parse(msg)).toEqual(msg);
    });

    it("rejects cols below 1", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 0, rows: 40 })).toThrow();
    });

    it("rejects cols above 500", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 501, rows: 40 })).toThrow();
    });

    it("rejects rows below 1", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 80, rows: 0 })).toThrow();
    });

    it("rejects rows above 200", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 80, rows: 201 })).toThrow();
    });

    it("rejects non-integer cols", () => {
      expect(() => ResizeSchema.parse({ type: "resize", cols: 80.5, rows: 40 })).toThrow();
    });
  });

  describe("DetachSchema", () => {
    it("accepts valid detach", () => {
      const msg = { type: "detach" };
      expect(DetachSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("ClientMessageSchema (union)", () => {
    it("parses attach-new", () => {
      const result = ClientMessageSchema.parse({ type: "attach", cwd: "/home" });
      expect(result.type).toBe("attach");
    });

    it("parses attach-existing", () => {
      const result = ClientMessageSchema.parse({ type: "attach", sessionId: "550e8400-e29b-41d4-a716-446655440000" });
      expect(result.type).toBe("attach");
    });

    it("parses input", () => {
      const result = ClientMessageSchema.parse({ type: "input", data: "hello" });
      expect(result).toEqual({ type: "input", data: "hello" });
    });

    it("parses resize", () => {
      const result = ClientMessageSchema.parse({ type: "resize", cols: 80, rows: 24 });
      expect(result).toEqual({ type: "resize", cols: 80, rows: 24 });
    });

    it("parses detach", () => {
      const result = ClientMessageSchema.parse({ type: "detach" });
      expect(result).toEqual({ type: "detach" });
    });

    it("rejects unknown type", () => {
      expect(() => ClientMessageSchema.parse({ type: "unknown" })).toThrow();
    });

    it("rejects missing type", () => {
      expect(() => ClientMessageSchema.parse({ data: "hello" })).toThrow();
    });
  });
});
