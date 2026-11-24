// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import { useTerminalWindowKeys } from "@desktop/renderer/src/features/terminal-window/use-terminal-window-keys";

// ENG-521: a terminal in the Terminal window hands the window's keys to its menu, and those keys
// follow the Shortcuts settings; a key no longer bound goes back to the terminal.
type Listener = (payload: unknown) => void;
const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("Terminal window keys", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reserves the keys set in Shortcuts settings and follows their changes", async () => {
    const listeners: Listener[] = [];
    const effective = { ...resolveShortcuts(null, "other"), "terminal-window.split-right": ["F7"] };
    window.operator = {
      invoke: vi.fn(async (channel: string) => (channel === "shortcuts:get" ? { platform: "other", overrides: { version: 1, overrides: {} }, effective } : { ok: true })),
      on: (channel: string, callback: Listener) => {
        if (channel === "shortcuts:changed") listeners.push(callback);
        return () => undefined;
      },
    } as never;
    const { result } = renderHook(() => useTerminalWindowKeys());
    // The defaults apply until the settings arrive.
    expect(result.current(key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }))).toBe(true);
    await waitFor(() => expect(result.current(key({ key: "F7", code: "F7" }))).toBe(true));
    expect(result.current(key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }))).toBe(false);
    // Fixed keys: Ctrl+digits switch space.
    expect(result.current(key({ key: "2", code: "Digit2", ctrlKey: true }))).toBe(true);
    act(() => { for (const listener of listeners) listener({ platform: "other", overrides: { version: 1, overrides: {} }, effective: resolveShortcuts(null, "other") }); });
    expect(result.current(key({ key: "F7", code: "F7" }))).toBe(false);
    expect(result.current(key({ key: "C", code: "KeyC", ctrlKey: true }))).toBe(false);
  });
});
