// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useCommandStore } from "../../shell/src/stores/commands.js";
import { matchShortcut } from "../../shell/src/hooks/useGlobalShortcuts.js";

function makeKeyEvent(
  key: string,
  opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
  });
}

describe("Command Store", () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: new Map() });
  });

  it("registers commands by id", () => {
    const { register } = useCommandStore.getState();
    register([
      { id: "a", label: "Alpha", group: "Apps", execute: vi.fn() },
      { id: "b", label: "Beta", group: "Actions", execute: vi.fn() },
    ]);
    const cmds = useCommandStore.getState().commands;
    expect(cmds.size).toBe(2);
    expect(cmds.get("a")?.label).toBe("Alpha");
    expect(cmds.get("b")?.label).toBe("Beta");
  });

  it("overwrites existing commands with same id", () => {
    const { register } = useCommandStore.getState();
    register([{ id: "a", label: "V1", group: "Apps", execute: vi.fn() }]);
    register([{ id: "a", label: "V2", group: "Apps", execute: vi.fn() }]);
    const cmds = useCommandStore.getState().commands;
    expect(cmds.size).toBe(1);
    expect(cmds.get("a")?.label).toBe("V2");
  });

  it("unregisters commands by id", () => {
    const { register } = useCommandStore.getState();
    register([
      { id: "a", label: "A", group: "Apps", execute: vi.fn() },
      { id: "b", label: "B", group: "Apps", execute: vi.fn() },
    ]);
    useCommandStore.getState().unregister(["a"]);
    const cmds = useCommandStore.getState().commands;
    expect(cmds.size).toBe(1);
    expect(cmds.has("a")).toBe(false);
    expect(cmds.has("b")).toBe(true);
  });

  it("unregister is idempotent for missing ids", () => {
    useCommandStore.getState().unregister(["nonexistent"]);
    expect(useCommandStore.getState().commands.size).toBe(0);
  });
});

describe("matchShortcut", () => {
  it("matches Cmd+J with metaKey", () => {
    expect(matchShortcut("Cmd+J", makeKeyEvent("j", { metaKey: true }))).toBe(true);
  });

  it("matches Cmd+J with ctrlKey", () => {
    expect(matchShortcut("Cmd+J", makeKeyEvent("j", { ctrlKey: true }))).toBe(true);
  });

  it("rejects Cmd+J without modifier", () => {
    expect(matchShortcut("Cmd+J", makeKeyEvent("j"))).toBe(false);
  });

  it("rejects Cmd+J with wrong key", () => {
    expect(matchShortcut("Cmd+J", makeKeyEvent("k", { metaKey: true }))).toBe(false);
  });

  it("matches F3 without modifiers", () => {
    expect(matchShortcut("F3", makeKeyEvent("F3"))).toBe(true);
  });

  it("rejects F3 when modifier is pressed", () => {
    expect(matchShortcut("F3", makeKeyEvent("F3", { metaKey: true }))).toBe(false);
  });

  it("matches Cmd+Shift+P", () => {
    expect(
      matchShortcut("Cmd+Shift+P", makeKeyEvent("p", { metaKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("rejects Cmd+Shift+P without shift", () => {
    expect(matchShortcut("Cmd+Shift+P", makeKeyEvent("p", { metaKey: true }))).toBe(false);
  });

  it("is case-insensitive for shortcut string", () => {
    expect(matchShortcut("cmd+k", makeKeyEvent("k", { metaKey: true }))).toBe(true);
  });

  it("matches Escape", () => {
    expect(matchShortcut("Escape", makeKeyEvent("Escape"))).toBe(true);
  });
});
