import { describe, expect, it } from "vitest";
import { parseSyncEventMessage } from "../../src/daemon/ws-client.js";

describe("parseSyncEventMessage", () => {
  it("returns sync events", () => {
    expect(
      parseSyncEventMessage(JSON.stringify({
        type: "sync:change",
        path: "notes/today.md",
        action: "update",
        hash: `sha256:${"a".repeat(64)}`,
        peerId: "laptop-1",
      })),
    ).toMatchObject({ type: "sync:change", path: "notes/today.md" });
  });

  it("ignores non-sync messages", () => {
    expect(parseSyncEventMessage(JSON.stringify({ type: "pong" }))).toBeNull();
  });

  it("rejects malformed sync payloads instead of casting them through", () => {
    expect(() =>
      parseSyncEventMessage(JSON.stringify({ type: "sync:change", path: "notes/today.md" })),
    ).toThrow();
  });

  it("throws on malformed messages so callers can log them", () => {
    expect(() => parseSyncEventMessage("{not-json")).toThrow();
  });
});
