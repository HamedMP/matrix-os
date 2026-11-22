import { describe, expect, it, vi } from "vitest";
import { resolveShortcuts, type EffectiveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import { createShortcutInputMatcher, type ShortcutInput } from "@desktop/main/shortcuts/input-matcher";

const MAC_DEFAULTS = resolveShortcuts(null, "mac");

function input(overrides: Partial<ShortcutInput>): ShortcutInput {
  return { type: "keyDown", key: "a", code: "KeyA", meta: false, control: false, alt: false, shift: false, ...overrides };
}

function setup(options: { effective?: EffectiveShortcuts; recording?: boolean } = {}) {
  const run = vi.fn();
  const matcher = createShortcutInputMatcher({
    effective: () => options.effective ?? MAC_DEFAULTS,
    platform: "mac",
    isRecording: () => options.recording ?? false,
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
    const matcher = createShortcutInputMatcher({ effective: () => effective, platform: "mac", isRecording: () => false, run });
    effective = { ...MAC_DEFAULTS, "app.next": ["F8"] };
    matcher({ preventDefault: vi.fn() }, input({ key: "F8", code: "F8" }));
    matcher({ preventDefault: vi.fn() }, input(CTRL_TAB));
    expect(run.mock.calls).toEqual([["app.next"]]);
  });
});
