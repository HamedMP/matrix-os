// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalKeyboardPreferencesSchema, type TerminalKeyboardPreferences } from "@matrix-os/contracts";
import { useTerminalShortcutClaims } from "@desktop/renderer/src/features/terminal/use-terminal-shortcut-claims";

const STANDARD = TerminalKeyboardPreferencesSchema.parse({ profile: "standard" });
const MAC = TerminalKeyboardPreferencesSchema.parse({ profile: "mac" });

let invoke: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let input: HTMLTextAreaElement;
let outside: HTMLButtonElement;

function claims(): string[][] {
  return invoke.mock.calls
    .filter(([channel]) => channel === "shortcuts:set-terminal-claims")
    .map(([, payload]) => (payload as { bindings: string[] }).bindings);
}

function mount(initial: { preferences?: TerminalKeyboardPreferences; isMac?: boolean; enabled?: boolean } = {}) {
  const ref = { current: host };
  return renderHook(
    (props: { preferences: TerminalKeyboardPreferences; isMac: boolean; enabled: boolean }) =>
      useTerminalShortcutClaims(ref, props),
    { initialProps: { preferences: STANDARD, isMac: true, enabled: true, ...initial } },
  );
}

beforeEach(() => {
  invoke = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("operator", { invoke, on: vi.fn(() => () => undefined) });
  host = document.createElement("div");
  input = document.createElement("textarea");
  host.append(input);
  outside = document.createElement("button");
  document.body.append(host, outside);
});

afterEach(() => {
  cleanup();
  host.remove();
  outside.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTerminalShortcutClaims", () => {
  it("claims the active profile's keys while the Terminal has focus and ends the claim on blur", () => {
    mount();
    expect(claims()).toEqual([]);
    act(() => input.focus());
    expect(claims()).toHaveLength(1);
    expect(claims()[0]).toEqual(expect.arrayContaining(["Ctrl+Shift+Left", "Ctrl+Shift+Enter"]));
    act(() => outside.focus());
    expect(claims().at(-1)).toEqual([]);
  });

  it("does not claim the window arrangement keys under the default macOS profile", () => {
    mount({ preferences: MAC });
    act(() => input.focus());
    expect(claims()[0]).toContain("Cmd+Alt+Left");
    expect(claims()[0]).not.toContain("Ctrl+Shift+Left");
  });

  it("ends the claim when the window loses focus and claims again when it returns", () => {
    mount();
    act(() => input.focus());
    act(() => { window.dispatchEvent(new FocusEvent("blur")); });
    expect(claims().at(-1)).toEqual([]);
    act(() => { window.dispatchEvent(new FocusEvent("focus")); });
    expect(claims().at(-1)).toContain("Ctrl+Shift+Left");
    expect(claims()).toHaveLength(3);
  });

  it("re-sends the claim when the profile or overrides change while focused", () => {
    const view = mount();
    act(() => input.focus());
    view.rerender({ preferences: MAC, isMac: true, enabled: true });
    expect(claims().at(-1)).toContain("Cmd+Alt+Left");
    expect(claims().at(-1)).not.toContain("Ctrl+Shift+Left");
    const custom = TerminalKeyboardPreferencesSchema.parse({ profile: "standard", overrides: { "focus-left": "Ctrl+Alt+H" } });
    view.rerender({ preferences: custom, isMac: true, enabled: true });
    expect(claims().at(-1)).toContain("Ctrl+Alt+H");
    expect(claims().at(-1)).not.toContain("Ctrl+Shift+Left");
  });

  it("claims an already focused Terminal on mount and ends the claim on unmount", () => {
    input.focus();
    const view = mount();
    expect(claims()).toHaveLength(1);
    view.unmount();
    expect(claims().at(-1)).toEqual([]);
  });

  it("claims nothing while disabled or under the passthrough profile, and ends a claim when disabled", () => {
    const view = mount({ enabled: false });
    act(() => input.focus());
    expect(claims()).toEqual([]);
    view.rerender({ preferences: TerminalKeyboardPreferencesSchema.parse({ profile: "passthrough" }), isMac: true, enabled: true });
    expect(claims()).toEqual([]);
    view.rerender({ preferences: STANDARD, isMac: true, enabled: true });
    expect(claims()).toHaveLength(1);
    view.rerender({ preferences: STANDARD, isMac: true, enabled: false });
    expect(claims().at(-1)).toEqual([]);
  });

  it("leaves another Terminal's claim alone when an unfocused one unmounts", () => {
    const view = mount();
    view.unmount();
    expect(claims()).toEqual([]);
  });

  it("logs a failed report without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("invalid request"));
    mount();
    act(() => input.focus());
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    vi.unstubAllGlobals();
    expect(() => act(() => outside.focus())).not.toThrow();
  });
});
