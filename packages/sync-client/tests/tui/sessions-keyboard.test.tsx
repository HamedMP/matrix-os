import { describe, expect, it } from "vitest";
import { resolveSessionKeyboardIntent } from "../../src/cli/tui/sessions/session-actions.js";

describe("session keyboard handling", () => {
  it("maps Enter, n, r, k, and Escape to stable intents", () => {
    expect(resolveSessionKeyboardIntent("", { return: true })).toBe("attach");
    expect(resolveSessionKeyboardIntent("n")).toBe("create");
    expect(resolveSessionKeyboardIntent("r")).toBe("refresh");
    expect(resolveSessionKeyboardIntent("k")).toBe("remove");
    expect(resolveSessionKeyboardIntent("", { escape: true })).toBe("close");
  });
});
