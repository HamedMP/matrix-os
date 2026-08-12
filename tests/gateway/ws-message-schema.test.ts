import { describe, expect, it } from "vitest";
import { MainWsClientMessageSchema } from "../../packages/gateway/src/ws-message-schema.js";

describe("main websocket file-directory frames", () => {
  it.each([
    { type: "files:subscribe", directory: "" },
    { type: "files:subscribe", directory: "projects/demo" },
    { type: "files:unsubscribe", directory: "projects/demo" },
    { type: "files:touch", directory: "projects/demo" },
  ])("accepts the strict $type contract", (frame) => {
    expect(MainWsClientMessageSchema.safeParse(frame)).toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  it.each([
    { type: "files:subscribe" },
    { type: "files:subscribe", directory: "projects", ownerId: "attacker" },
    { type: "files:subscribe", directory: "/projects" },
    { type: "files:subscribe", directory: "C:/projects" },
    { type: "files:subscribe", directory: "projects/../system" },
    { type: "files:subscribe", directory: "projects\\demo" },
    { type: "files:subscribe", directory: "projects\u0000demo" },
    { type: "files:unknown", directory: "projects" },
  ])("rejects malformed or non-canonical file frames %#", (frame) => {
    expect(MainWsClientMessageSchema.safeParse(frame).success).toBe(false);
  });

  it("enforces the shared 4,096 UTF-8 byte directory boundary", () => {
    const atLimit = `p/${"a".repeat(4_094)}`;
    const overLimit = `${atLimit}a`;
    const multibyteOverLimit = `p/${"界".repeat(1_365)}`;

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(4_096);
    expect(MainWsClientMessageSchema.safeParse({
      type: "files:subscribe",
      directory: atLimit,
    }).success).toBe(true);
    expect(MainWsClientMessageSchema.safeParse({
      type: "files:subscribe",
      directory: overLimit,
    }).success).toBe(false);
    expect(MainWsClientMessageSchema.safeParse({
      type: "files:subscribe",
      directory: multibyteOverLimit,
    }).success).toBe(false);
  });
});
