import { describe, expect, it } from "vitest";
import {
  buildWebSocketOptions,
  buildSyncSubscribeMessage,
  parseSyncEventMessage,
  WS_HANDSHAKE_TIMEOUT_MS,
} from "../../src/daemon/ws-client.js";

describe("parseSyncEventMessage", () => {
  it("returns batched sync change events", () => {
    expect(
      parseSyncEventMessage(JSON.stringify({
        type: "sync:change",
        files: [
          {
            path: "notes/today.md",
            action: "update",
            hash: `sha256:${"a".repeat(64)}`,
            size: 12,
          },
          {
            path: "notes/done.md",
            action: "delete",
            hash: `sha256:${"b".repeat(64)}`,
            size: 0,
          },
        ],
        peerId: "laptop-1",
        manifestVersion: 7,
      })),
    ).toMatchObject({
      type: "sync:change",
      peerId: "laptop-1",
      manifestVersion: 7,
      files: [
        { path: "notes/today.md", action: "update" },
        { path: "notes/done.md", action: "delete" },
      ],
    });
  });

  it("normalizes legacy single-file sync change events", () => {
    expect(
      parseSyncEventMessage(JSON.stringify({
        type: "sync:change",
        path: "notes/today.md",
        action: "create",
        hash: `sha256:${"a".repeat(64)}`,
        peerId: "laptop-1",
      })),
    ).toMatchObject({
      type: "sync:change",
      peerId: "laptop-1",
      files: [{ path: "notes/today.md", action: "create", size: 0 }],
    });
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

describe("buildSyncSubscribeMessage", () => {
  it("includes the required peer metadata for gateway registration", () => {
    expect(
      buildSyncSubscribeMessage({
        peerId: "peer-1",
        hostname: "mbp",
        platform: "darwin",
        clientVersion: "0.1.0",
      }),
    ).toEqual({
      type: "sync:subscribe",
      peerId: "peer-1",
      hostname: "mbp",
      platform: "darwin",
      clientVersion: "0.1.0",
    });
  });
});

describe("buildWebSocketOptions", () => {
  it("sets auth headers and a finite handshake timeout", () => {
    expect(buildWebSocketOptions("token-123")).toEqual({
      headers: { authorization: "Bearer token-123" },
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
    });
  });
});
