import { describe, expect, it, vi } from "vitest";
import { resolveShortcuts, type EffectiveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import {
  createShortcutInputMatcher,
  isMainProcessShortcut,
  isTerminalControlChord,
  type ShortcutInput,
} from "@desktop/main/shortcuts/input-matcher";
import type { ShortcutActionId, ShortcutPlatform } from "@matrix-os/contracts/keyboard-shortcuts";

const MAC_DEFAULTS = resolveShortcuts(null, "mac");
const OTHER_DEFAULTS = resolveShortcuts(null, "other");

function input(overrides: Partial<ShortcutInput>): ShortcutInput {
  return {
    type: "keyDown", key: "a", code: "KeyA", meta: false, control: false, alt: false, shift: false, isAutoRepeat: false,
    ...overrides,
  };
}

function setup(options: {
  effective?: EffectiveShortcuts;
  recording?: boolean;
  platform?: ShortcutPlatform;
  isAvailable?: (id: ShortcutActionId) => boolean;
} = {}) {
  const run = vi.fn();
  const platform = options.platform ?? "mac";
  const matcher = createShortcutInputMatcher({
    effective: () => options.effective ?? (platform === "mac" ? MAC_DEFAULTS : OTHER_DEFAULTS),
    platform,
    isRecording: () => options.recording ?? false,
    isAvailable: options.isAvailable ?? (() => true),
    run,
  });
  const press = (value: Partial<ShortcutInput>) => {
    const event = { preventDefault: vi.fn() };
    matcher(event, input(value));
    return event.preventDefault;
  };
  return { run, press };
}

const CTRL_TAB = { key: "Tab", code: "Tab", control: true };

describe("shortcut input matcher", () => {
  it("runs a bound action once and stops the page and menu from seeing the key", () => {
    const { run, press } = setup();
    const preventDefault = press(CTRL_TAB);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("app.next");
  });

  it("switches apps from the digit row on a layout that types punctuation there (AZERTY)", () => {
    const { run, press } = setup();
    expect(press({ key: "'", code: "Digit4", meta: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("app.switch-4");
  });

  it("leaves a digit-row key to the menu when its character is a native menu key (AZERTY Cmd+- zooms out)", () => {
    const { run, press } = setup();
    expect(press({ key: "-", code: "Digit6", meta: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores key-up events", () => {
    const { run, press } = setup();
    expect(press({ ...CTRL_TAB, type: "keyUp" })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("lets unbound keys through to the page", () => {
    const { run, press } = setup();
    expect(press({ key: "c", code: "KeyC", meta: true })).not.toHaveBeenCalled();
    expect(press({ key: "a", code: "KeyA" })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("matches every binding of an action, not only the first", () => {
    const { run, press } = setup({ effective: { ...MAC_DEFAULTS, "app.close": ["Cmd+Shift+W", "F6"] } });
    expect(press({ key: "F6", code: "F6" })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("app.close");
  });

  it("leaves Ctrl+Space to the page on Windows and Linux, where it is a terminal and IME key", () => {
    const { run, press } = setup({ platform: "other" });
    expect(press({ key: " ", code: "Space", control: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("still runs the App Launcher from Alt+Space on macOS", () => {
    const { run, press } = setup({ platform: "mac" });
    expect(press({ key: " ", code: "Space", alt: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("app.launcher");
  });

  it("does nothing while a shortcut is being recorded", () => {
    const { run, press } = setup({ recording: true });
    expect(press(CTRL_TAB)).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("matches by physical key on non-Latin layouts", () => {
    const { run, press } = setup();
    expect(press({ key: "ض", code: "KeyQ", meta: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("app.close");
  });

  it("follows changes to the effective bindings", () => {
    let effective: EffectiveShortcuts = MAC_DEFAULTS;
    const run = vi.fn();
    const matcher = createShortcutInputMatcher({
      effective: () => effective, platform: "mac", isRecording: () => false, isAvailable: () => true, run,
    });
    effective = { ...MAC_DEFAULTS, "app.next": ["F8"] };
    matcher({ preventDefault: vi.fn() }, input({ key: "F8", code: "F8" }));
    matcher({ preventDefault: vi.fn() }, input(CTRL_TAB));
    expect(run.mock.calls).toEqual([["app.next"]]);
  });

  it("leaves terminal control chords to the page", () => {
    const { run, press } = setup({ platform: "other" });
    expect(press({ key: "q", code: "KeyQ", control: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(press(CTRL_TAB)).toHaveBeenCalledTimes(1);
    expect(press({ key: "T", code: "KeyT", control: true, shift: true })).toHaveBeenCalledTimes(1);
    expect(press({ key: "1", code: "Digit1", control: true })).toHaveBeenCalledTimes(1);
    expect(run.mock.calls).toEqual([["app.next"], ["app.reopen"], ["app.switch-1"]]);
  });

  it("skips a control-chord binding on mac but matches the Cmd one", () => {
    const { run, press } = setup({ effective: { ...MAC_DEFAULTS, "app.close": ["Cmd+Q", "Ctrl+K"] } });
    expect(press({ key: "k", code: "KeyK", control: true })).not.toHaveBeenCalled();
    expect(press({ key: "q", code: "KeyQ", meta: true })).toHaveBeenCalledTimes(1);
    expect(run.mock.calls).toEqual([["app.close"]]);
  });

  it("never matches an action that is unavailable on this platform", () => {
    const { run, press } = setup({ isAvailable: (id) => id !== "app.close" });
    expect(press({ key: "q", code: "KeyQ", meta: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves actions outside the Apps group to the page and the menu", () => {
    const { run, press } = setup();
    for (const key of ["n", "k", "w", "j"]) {
      expect(press({ key, code: `Key${key.toUpperCase()}`, meta: true }), `Cmd+${key}`).not.toHaveBeenCalled();
    }
    expect(press({ key: "T", code: "KeyT", meta: true, alt: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("still matches every Apps action with focus anywhere", () => {
    const { run, press } = setup();
    const keys: Array<Partial<ShortcutInput>> = [
      CTRL_TAB,
      { key: " ", code: "Space", alt: true },
      { key: "q", code: "KeyQ", meta: true },
      { key: "m", code: "KeyM", meta: true },
      { key: "3", code: "Digit3", meta: true },
      { key: "T", code: "KeyT", meta: true, shift: true },
    ];
    for (const key of keys) expect(press(key)).toHaveBeenCalledTimes(1);
    expect(run.mock.calls).toEqual([["app.next"], ["app.launcher"], ["app.close"], ["app.minimize"], ["app.switch-3"], ["app.reopen"]]);
  });

  it("repeats Next app and Previous app while the key is held", () => {
    const { run, press } = setup();
    expect(press({ ...CTRL_TAB, isAutoRepeat: true })).toHaveBeenCalledTimes(1);
    expect(press({ ...CTRL_TAB, shift: true, isAutoRepeat: true })).toHaveBeenCalledTimes(1);
    expect(run.mock.calls).toEqual([["app.next"], ["app.previous"]]);
  });

  it("swallows auto-repeat of other bound keys without running them again", () => {
    const { run, press } = setup();
    expect(press({ key: "q", code: "KeyQ", meta: true, isAutoRepeat: true })).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(press({ key: "a", code: "KeyA", isAutoRepeat: true })).not.toHaveBeenCalled();
  });
});

describe("isMainProcessShortcut", () => {
  it("is true exactly for the Apps group", () => {
    expect(isMainProcessShortcut("app.next")).toBe(true);
    expect(isMainProcessShortcut("app.switch-9")).toBe(true);
    expect(isMainProcessShortcut("app.open-files")).toBe(true);
    expect(isMainProcessShortcut("app.tile-left")).toBe(true);
    expect(isMainProcessShortcut("app.restore-size")).toBe(true);
    for (const id of ["nav.palette", "tabs.new-context", "chat.new-thread", "terminal.focus", "terminal.window"] as const) {
      expect(isMainProcessShortcut(id), id).toBe(false);
    }
  });
});

describe("window arrangement keys", () => {
  it.each(["mac", "other"] as const)("arranges the selected app from any focus on %s", (platform) => {
    const { run, press } = setup({ platform });
    const keys: Array<[Partial<ShortcutInput>, ShortcutActionId]> = [
      [{ key: "ArrowLeft", code: "ArrowLeft" }, "app.tile-left"],
      [{ key: "ArrowRight", code: "ArrowRight" }, "app.tile-right"],
      [{ key: "ArrowUp", code: "ArrowUp" }, "app.tile-top"],
      [{ key: "ArrowDown", code: "ArrowDown" }, "app.tile-bottom"],
      [{ key: "Enter", code: "Enter" }, "app.toggle-full-size"],
      [{ key: "Backspace", code: "Backspace" }, "app.restore-size"],
    ];
    for (const [key, id] of keys) {
      expect(press({ ...key, control: true, alt: true }), id).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenLastCalledWith(id);
    }
    expect(run).toHaveBeenCalledTimes(keys.length);
  });

  it("does not repeat a tile while the key is held", () => {
    const { run, press } = setup();
    press({ key: "ArrowLeft", code: "ArrowLeft", control: true, alt: true });
    press({ key: "ArrowLeft", code: "ArrowLeft", control: true, alt: true, isAutoRepeat: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("isTerminalControlChord", () => {
  it("is Ctrl alone plus a letter, Space or one of [ \\ ]", () => {
    for (const binding of ["Ctrl+W", "Ctrl+A", "Ctrl+Z", "Ctrl+[", "Ctrl+\\", "Ctrl+]", "Ctrl+Space"]) {
      expect(isTerminalControlChord(binding), binding).toBe(true);
    }
    for (const binding of ["Ctrl+Tab", "Ctrl+1", "Ctrl+Shift+T", "Ctrl+Alt+T", "Cmd+W", "Cmd+Ctrl+W", "W", "Ctrl+,", "Ctrl+F1", "Alt+Space", "Ctrl+Shift+Space"]) {
      expect(isTerminalControlChord(binding), binding).toBe(false);
    }
  });
});
