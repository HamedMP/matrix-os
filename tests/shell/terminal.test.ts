import { afterEach, describe, it, expect, vi } from "vitest";
import {
  isCanonicalShellSessionId,
  terminalWebSocketPathForSession,
} from "../../shell/src/components/terminal/terminal-session-id.js";
import { twoWordSessionName } from "../../shell/src/components/terminal/terminal-session-names.js";

describe("Terminal WebSocket protocol", () => {
  const terminalRef = {
    workspaceId: `tws_${"a".repeat(32)}`,
    tabId: `tt_${"b".repeat(32)}`,
  };
  const refKey = `${terminalRef.workspaceId}:${terminalRef.tabId}`;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes only stable workspace/tab refs and always uses the tab route", () => {
    expect(isCanonicalShellSessionId(refKey)).toBe(true);
    expect(isCanonicalShellSessionId("main")).toBe(false);
    expect(isCanonicalShellSessionId("term_observe_abc123")).toBe(false);
    expect(terminalWebSocketPathForSession(refKey)).toBe("/ws/terminal/tab");
    expect(terminalWebSocketPathForSession(null)).toBe("/ws/terminal/tab");
  });

  it("rejects legacy named sessions and keeps every fallback on the tab route", () => {
    const sessionId = `provider-auth-${"a".repeat(50)}`;
    expect(sessionId).toHaveLength(64);
    for (const invalid of [
      "",
      sessionId,
      `${sessionId}a`,
      "../login",
      "login?token=x",
      "LOGIN",
      "-login",
      "login\n",
      "550E8400-E29B-41D4-A716-446655440000",
    ]) {
      expect(isCanonicalShellSessionId(invalid)).toBe(false);
      expect(terminalWebSocketPathForSession(invalid)).toBe("/ws/terminal/tab");
    }
  });

  it("uses two-word friendly terminal session names by default", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(twoWordSessionName()).toBe("swift-falcon");
  });
});
