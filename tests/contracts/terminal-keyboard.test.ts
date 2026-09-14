import { describe, expect, it } from "vitest";
import {
  resolveTerminalShortcut,
  TerminalKeyboardPreferencesSchema,
  TerminalPaneActionSchema,
} from "../../packages/contracts/src/terminal-keyboard";
const event = (key: string, options = {}) => ({
  type: "keydown",
  key,
  isMac: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...options,
});
const prefs = () => TerminalKeyboardPreferencesSchema.parse({});
describe("terminal shortcuts", () => {
  it.each([
    ["ArrowLeft", "\x01"],
    ["ArrowRight", "\x05"],
    ["Backspace", "\x15"],
  ])("maps Cmd %s to shell editing", (key, data) => {
    expect(
      resolveTerminalShortcut(event(key, { metaKey: true }), prefs()),
    ).toEqual({ kind: "input", data });
  });
  it.each([
    ["ArrowLeft", "\x1bb"],
    ["ArrowRight", "\x1bf"],
    ["Backspace", "\x1b\x7f"],
  ])("maps Option %s", (key, data) => {
    expect(
      resolveTerminalShortcut(event(key, { altKey: true }), prefs()),
    ).toEqual({ kind: "input", data });
  });
  it.each(["Left", "Right", "Up", "Down"])(
    "focus and resize %s",
    (direction) => {
      expect(
        resolveTerminalShortcut(
          event(`Arrow${direction}`, { metaKey: true, altKey: true }),
          prefs(),
        ),
      ).toEqual({
        kind: "pane",
        action: { type: "focus", direction: direction.toLowerCase() },
      });
      expect(
        resolveTerminalShortcut(
          event(`Arrow${direction}`, {
            metaKey: true,
            altKey: true,
            shiftKey: true,
          }),
          prefs(),
        ),
      ).toEqual({
        kind: "pane",
        action: { type: "resize", direction: direction.toLowerCase() },
      });
    },
  );
  it("splits and maximizes without leaking input", () => {
    expect(
      resolveTerminalShortcut(event("d", { metaKey: true }), prefs()),
    ).toEqual({ kind: "pane", action: { type: "split", direction: "right" } });
    expect(
      resolveTerminalShortcut(
        event("D", { metaKey: true, shiftKey: true }),
        prefs(),
      ),
    ).toEqual({ kind: "pane", action: { type: "split", direction: "down" } });
    expect(
      resolveTerminalShortcut(
        event("Enter", { metaKey: true, shiftKey: true }),
        prefs(),
      ),
    ).toEqual({ kind: "pane", action: { type: "fullscreen" } });
    expect(
      resolveTerminalShortcut(event("ArrowUp", { metaKey: true }), prefs()),
    ).toEqual({ kind: "pane", action: { type: "scroll", edge: "top" } });
    expect(
      resolveTerminalShortcut(event("ArrowDown", { metaKey: true }), prefs()),
    ).toEqual({ kind: "pane", action: { type: "scroll", edge: "bottom" } });
  });
  it("preserves composition, AltGraph, selection modifiers and foreign-platform keys", () => {
    for (const extra of [
      { isComposing: true },
      { type: "keyup" },
      { type: "keypress" },
      { shiftKey: true },
      { ctrlKey: true },
      { isMac: false },
    ]) {
      expect(
        resolveTerminalShortcut(
          event("ArrowLeft", { metaKey: true, ...extra }),
          prefs(),
        ),
      ).toBeNull();
    }
    expect(
      resolveTerminalShortcut(
        event("ArrowLeft", { altKey: true, ctrlKey: true }),
        prefs(),
      ),
    ).toBeNull();
  });
  it("consumes repeated destructive shortcuts without repeating actions; allows repeated movement", () => {
    expect(
      resolveTerminalShortcut(
        event("d", { metaKey: true, repeat: true }),
        prefs(),
      ),
    ).toEqual({ kind: "consume" });
    expect(
      resolveTerminalShortcut(
        event("ArrowLeft", { metaKey: true, repeat: true }),
        prefs(),
      ),
    ).toEqual({ kind: "input", data: "\x01" });
  });
  it("provides prefix fallback and consumes cancellation/unknown prefix keys", () => {
    expect(
      resolveTerminalShortcut(event("g", { ctrlKey: true }), prefs()),
    ).toEqual({ kind: "prefix" });
    expect(resolveTerminalShortcut(event("v"), prefs(), true)).toEqual({
      kind: "pane",
      action: { type: "split", direction: "right" },
    });
    expect(resolveTerminalShortcut(event("h"), prefs(), true)).toEqual({
      kind: "pane",
      action: { type: "focus", direction: "left" },
    });
    expect(resolveTerminalShortcut(event("Escape"), prefs(), true)).toEqual({
      kind: "consume",
    });
    expect(resolveTerminalShortcut(event("q"), prefs(), true)).toEqual({
      kind: "consume",
    });
  });
  it("supports remapping, disabling and passthrough", () => {
    const p = TerminalKeyboardPreferencesSchema.parse({
      overrides: { "split-right": "Ctrl+Shift+Y", "word-left": null },
    });
    expect(
      resolveTerminalShortcut(event("Y", { ctrlKey: true, shiftKey: true }), p),
    ).toEqual({ kind: "pane", action: { type: "split", direction: "right" } });
    expect(
      resolveTerminalShortcut(event("d", { metaKey: true }), p),
    ).toBeNull();
    expect(
      resolveTerminalShortcut(event("ArrowLeft", { altKey: true }), p),
    ).toBeNull();
    expect(
      resolveTerminalShortcut(event("d", { metaKey: true }), {
        profile: "passthrough",
        overrides: {},
      }),
    ).toBeNull();
  });
  it("standard profile has cross-platform pane shortcuts and preserves OS editing", () => {
    const p = TerminalKeyboardPreferencesSchema.parse({ profile: "standard" });
    expect(
      resolveTerminalShortcut(
        event("d", { ctrlKey: true, shiftKey: true, isMac: false }),
        p,
      ),
    ).toEqual({ kind: "pane", action: { type: "split", direction: "right" } });
    expect(
      resolveTerminalShortcut(event("ArrowLeft", { altKey: true }), p),
    ).toBeNull();
  });
  it("rejects invalid/unbounded/colliding bindings and action payloads", () => {
    for (const overrides of [
      { "split-right": "Ctrl+Shift+F" },
      { "split-right": "Alt+Shift+C" },
      { "split-right": "Meta+ArrowLeft" },
      { "split-right": "Meta+C" },
      { unknown: "Ctrl+X" },
      { "split-right": "x".repeat(100) },
      { "split-right": "Ctrl+Shift+X", "split-down": "Ctrl+Shift+X" },
      { "split-right": "not a shortcut" },
    ])
      expect(
        TerminalKeyboardPreferencesSchema.safeParse({ overrides }).success,
      ).toBe(false);
    expect(
      TerminalPaneActionSchema.safeParse({ type: "split", direction: "left" })
        .success,
    ).toBe(false);
    expect(
      TerminalPaneActionSchema.safeParse({ type: "fullscreen", command: "rm" })
        .success,
    ).toBe(false);
  });
});
