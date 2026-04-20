import { describe, expect, it } from "vitest";
import { parseSyncEventMessage } from "../../src/daemon/ws-client.js";

describe("parseSyncEventMessage", () => {
  it("returns sync events", () => {
    expect(
      parseSyncEventMessage(JSON.stringify({
        type: "sync:change",
        path: "notes/today.md",
        action: "update",
        hash: "abc",
      })),
    ).toMatchObject({ type: "sync:change", path: "notes/today.md" });
  });

  it("ignores non-sync messages", () => {
    expect(parseSyncEventMessage(JSON.stringify({ type: "pong" }))).toBeNull();
  });

  it("throws on malformed messages so callers can log them", () => {
    expect(() => parseSyncEventMessage("{not-json")).toThrow();
  });
});
