import { describe, expect, it } from "vitest";
import { MAX_CLAIMANTS, createTerminalClaims } from "@desktop/main/shortcuts/terminal-claims";
import { MAX_TERMINAL_CLAIMS } from "@desktop/shared/shortcuts-ipc";

describe("terminal shortcut claims", () => {
  it("holds claims per web contents and replaces them on each set", () => {
    const claims = createTerminalClaims("mac");
    const main = {};
    const terminal = {};
    claims.set(main, ["Ctrl+Shift+Left", "Ctrl+Shift+Enter"]);
    expect(claims.has(main, "Ctrl+Shift+Left")).toBe(true);
    expect(claims.has(terminal, "Ctrl+Shift+Left")).toBe(false);
    claims.set(main, ["Ctrl+Shift+Enter"]);
    expect(claims.has(main, "Ctrl+Shift+Left")).toBe(false);
    expect(claims.has(main, "Ctrl+Shift+Enter")).toBe(true);
  });

  it("forgets a sender when it clears or sends an empty list", () => {
    const claims = createTerminalClaims("mac");
    const main = {};
    claims.set(main, ["Ctrl+Shift+Left"]);
    claims.set(main, []);
    expect(claims.size()).toBe(0);
    claims.set(main, ["Ctrl+Shift+Left"]);
    claims.clear(main);
    expect(claims.has(main, "Ctrl+Shift+Left")).toBe(false);
    expect(claims.size()).toBe(0);
  });

  it("drops bindings that cannot be pressed on this platform", () => {
    const claims = createTerminalClaims("other");
    const main = {};
    claims.set(main, ["Cmd+Shift+Enter", "Ctrl+Shift+Left"]);
    expect(claims.has(main, "Cmd+Shift+Enter")).toBe(false);
    expect(claims.has(main, "Ctrl+Shift+Left")).toBe(true);
  });

  it("caps bindings per sender and the number of senders, evicting the oldest", () => {
    const claims = createTerminalClaims("mac");
    const letters = Array.from({ length: 26 }, (_, i) => `Ctrl+Alt+${String.fromCharCode(65 + i)}`);
    const one = {};
    claims.set(one, letters.concat(letters));
    expect(letters.filter((binding) => claims.has(one, binding))).toHaveLength(Math.min(26, MAX_TERMINAL_CLAIMS));

    const senders = Array.from({ length: MAX_CLAIMANTS + 1 }, () => ({}));
    for (const sender of senders) claims.set(sender, ["Ctrl+Shift+Left"]);
    expect(claims.size()).toBe(MAX_CLAIMANTS);
    expect(claims.has(one, "Ctrl+Alt+A")).toBe(false);
    expect(claims.has(senders[0]!, "Ctrl+Shift+Left")).toBe(false);
    expect(claims.has(senders.at(-1)!, "Ctrl+Shift+Left")).toBe(true);
  });

  it("clears everything at once", () => {
    const claims = createTerminalClaims("mac");
    claims.set({}, ["Ctrl+Shift+Left"]);
    claims.clearAll();
    expect(claims.size()).toBe(0);
  });
});
