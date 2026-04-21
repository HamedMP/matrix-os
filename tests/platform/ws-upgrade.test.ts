import { describe, it, expect } from "vitest";
import { isSafeWebSocketUpgradePath } from "../../packages/platform/src/ws-upgrade.js";

describe("isSafeWebSocketUpgradePath", () => {
  it("accepts normal websocket paths", () => {
    expect(isSafeWebSocketUpgradePath("/ws")).toBe(true);
    expect(isSafeWebSocketUpgradePath("/ws?token=abc")).toBe(true);
  });

  it("rejects CRLF injection in the request target", () => {
    expect(isSafeWebSocketUpgradePath("/ws\r\nX-Evil: yes")).toBe(false);
    expect(isSafeWebSocketUpgradePath("/ws\nGET /admin HTTP/1.1")).toBe(false);
  });
});
