import { describe, expect, it } from "vitest";
import {
  bindingFromKeyEvent,
  bindingFromTerminalShortcut,
  isCanonicalBinding,
  resolveShortcuts,
  terminalShortcutClaims,
} from "../../packages/contracts/src/keyboard-shortcuts";
import { TerminalKeyboardPreferencesSchema } from "../../packages/contracts/src/terminal-keyboard";

const standard = TerminalKeyboardPreferencesSchema.parse({ profile: "standard" });
const mac = TerminalKeyboardPreferencesSchema.parse({ profile: "mac" });

describe("bindingFromTerminalShortcut", () => {
  it("converts a terminal binding to the shortcut registry's canonical form", () => {
    expect(bindingFromTerminalShortcut("Ctrl+Shift+ArrowLeft", "mac")).toBe("Ctrl+Shift+Left");
    expect(bindingFromTerminalShortcut("Shift+Meta+Enter", "mac")).toBe("Cmd+Shift+Enter");
    expect(bindingFromTerminalShortcut("Alt+Shift+Meta+ArrowUp", "mac")).toBe("Cmd+Alt+Shift+Up");
    expect(bindingFromTerminalShortcut("Ctrl+Alt+Shift+ArrowDown", "other")).toBe("Ctrl+Alt+Shift+Down");
    expect(bindingFromTerminalShortcut("Meta+d", "mac")).toBe("Cmd+D");
    expect(bindingFromTerminalShortcut("Ctrl+Shift+Backspace", "other")).toBe("Ctrl+Shift+Backspace");
    expect(bindingFromTerminalShortcut("Alt+PageUp", "other")).toBe("Alt+PageUp");
  });

  it("accepts any modifier order and agrees with the binding a key press produces", () => {
    const fromTerminal = bindingFromTerminalShortcut("Shift+Ctrl+ArrowRight", "mac");
    const fromKey = bindingFromKeyEvent(
      { key: "ArrowRight", code: "ArrowRight", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      "mac",
    );
    expect(fromTerminal).toBe(fromKey);
  });

  it("drops Meta bindings off macOS, where the registry has no Cmd, and invalid input", () => {
    expect(bindingFromTerminalShortcut("Meta+D", "other")).toBeNull();
    expect(bindingFromTerminalShortcut("Ctrl+Hyper+A", "mac")).toBeNull();
    expect(bindingFromTerminalShortcut("ArrowLeft", "mac")).toBeNull();
    expect(bindingFromTerminalShortcut("", "mac")).toBeNull();
  });
});

describe("terminalShortcutClaims", () => {
  it("claims the Standard profile's pane keys that collide with window arrangement on macOS", () => {
    const claims = terminalShortcutClaims(standard, true);
    const arrange = resolveShortcuts(null, "mac");
    for (const id of ["app.tile-left", "app.tile-right", "app.tile-top", "app.tile-bottom", "app.toggle-full-size"] as const) {
      expect(claims).toContain(arrange[id][0]);
    }
    expect(claims).not.toContain("Ctrl+Shift+Backspace");
  });

  it("leaves window arrangement keys alone under the default macOS profile", () => {
    const claims = terminalShortcutClaims(mac, true);
    expect(claims).toContain("Cmd+Alt+Left");
    expect(claims).toContain("Cmd+Shift+Enter");
    expect(claims).not.toContain("Ctrl+Shift+Left");
    expect(claims).not.toContain("Ctrl+Tab");
  });

  it("follows the user's overrides, including unbinding a default", () => {
    const custom = TerminalKeyboardPreferencesSchema.parse({
      profile: "standard",
      overrides: { "focus-left": "Ctrl+Alt+H", fullscreen: null },
    });
    const claims = terminalShortcutClaims(custom, true);
    expect(claims).toContain("Ctrl+Alt+H");
    expect(claims).not.toContain("Ctrl+Shift+Left");
    expect(claims).not.toContain("Ctrl+Shift+Enter");
  });

  it("claims nothing for the passthrough profile, which ignores overrides", () => {
    const passthrough = TerminalKeyboardPreferencesSchema.parse({
      profile: "passthrough",
      overrides: { "focus-left": "Ctrl+Alt+H" },
    });
    expect(terminalShortcutClaims(passthrough, true)).toEqual([]);
  });

  it("returns unique canonical bindings for every profile and platform", () => {
    for (const profile of ["mac", "standard"] as const) {
      for (const isMac of [true, false]) {
        const claims = terminalShortcutClaims(TerminalKeyboardPreferencesSchema.parse({ profile }), isMac);
        expect(new Set(claims).size).toBe(claims.length);
        for (const claim of claims) expect(isCanonicalBinding(claim, isMac ? "mac" : "other")).toBe(true);
      }
    }
  });
});

describe("isCanonicalBinding", () => {
  it("accepts registry-form bindings and rejects terminal-form or reordered ones", () => {
    expect(isCanonicalBinding("Ctrl+Shift+Left", "mac")).toBe(true);
    expect(isCanonicalBinding("Cmd+Shift+Enter", "mac")).toBe(true);
    expect(isCanonicalBinding("Cmd+Shift+Enter", "other")).toBe(false);
    expect(isCanonicalBinding("Ctrl+Shift+ArrowLeft", "mac")).toBe(false);
    expect(isCanonicalBinding("Shift+Ctrl+Left", "mac")).toBe(false);
    expect(isCanonicalBinding("x".repeat(41), "mac")).toBe(false);
  });
});
