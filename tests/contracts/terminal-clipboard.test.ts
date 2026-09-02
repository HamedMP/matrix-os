import { describe, expect, it } from "vitest";
import {
  classifyTerminalClipboardShortcut,
  classifyTerminalPointerEvent,
  type TerminalClipboardShortcutInput,
  type TerminalPointerInput,
} from "@matrix-os/contracts";

function shortcut(
  overrides: Partial<TerminalClipboardShortcutInput> = {},
): TerminalClipboardShortcutInput {
  return {
    type: "keydown",
    key: "c",
    isMac: true,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    hasSelection: true,
    ...overrides,
  };
}

function pointer(overrides: Partial<TerminalPointerInput> = {}): TerminalPointerInput {
  return {
    type: "mousemove",
    button: 0,
    buttons: 0,
    hasSelection: true,
    ...overrides,
  };
}

describe("terminal clipboard shortcut contract", () => {
  it.each([
    [shortcut(), "copy"],
    [shortcut({ shiftKey: true }), "copy"],
    [shortcut({ isMac: false, metaKey: false, ctrlKey: true, shiftKey: true }), "copy"],
    [shortcut({ key: "V", hasSelection: false }), "paste"],
    [shortcut({ key: "v", isMac: false, metaKey: false, ctrlKey: true, shiftKey: true, hasSelection: false }), "paste"],
    [shortcut({ key: "a", hasSelection: false }), "select-all"],
  ] as const)("classifies an exact handled shortcut", (input, expected) => {
    expect(classifyTerminalClipboardShortcut(input)).toBe(expected);
  });

  it.each([
    shortcut({ type: "keyup" }),
    shortcut({ repeat: true }),
    shortcut({ isComposing: true }),
    shortcut({ hasSelection: false }),
    shortcut({ altKey: true }),
    shortcut({ ctrlKey: true }),
    shortcut({ key: "v", shiftKey: true, hasSelection: false }),
    shortcut({ key: "a", shiftKey: true, hasSelection: false }),
    shortcut({ key: "a", isMac: false, metaKey: false, ctrlKey: true, hasSelection: false }),
    shortcut({ key: "x" }),
  ])("does not consume inapplicable or ambiguous keyboard input", (input) => {
    expect(classifyTerminalClipboardShortcut(input)).toBeNull();
  });
});

describe("terminal selection pointer contract", () => {
  it.each([
    [pointer(), "shield-selection"],
    [pointer({ buttons: 2 }), "shield-selection"],
    [pointer({ button: 0, buttons: 3 }), "shield-selection"],
    [pointer({ button: 2, buttons: 3 }), "shield-selection"],
    [pointer({ type: "mousedown", button: 2, buttons: 2 }), "shield-selection"],
    [pointer({ type: "mouseup", button: 2, buttons: 0 }), "shield-selection"],
    [pointer({ type: "contextmenu", button: 2, buttons: 0 }), "open-context-menu"],
  ] as const)("protects a completed selection from passive and secondary input", (input, expected) => {
    expect(classifyTerminalPointerEvent(input)).toBe(expected);
  });

  it.each([
    pointer({ hasSelection: false }),
    pointer({ hasSelection: false, type: "mousedown", button: 2, buttons: 2 }),
    pointer({ type: "mousedown", button: 0, buttons: 1 }),
    pointer({ type: "mousemove", button: 0, buttons: 1 }),
    pointer({ type: "mousemove", button: 1, buttons: 4 }),
    pointer({ type: "mouseup", button: 0, buttons: 0 }),
    pointer({ hasSelection: false, type: "contextmenu", button: 2, buttons: 0 }),
  ])("forwards normal TUI mouse input and deliberate left-button actions", (input) => {
    expect(classifyTerminalPointerEvent(input)).toBe("forward");
  });
});
