import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyXtermScrollOptions,
  describeReadyState,
  shouldDisableWebglRenderer,
  toDisposableWebglAddon,
} from "../../shell/src/components/terminal/terminal-xterm-runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal xterm runtime", () => {
  it("applies the terminal's bounded scroll behavior", () => {
    const term = { options: {} };

    applyXtermScrollOptions(term as never);

    expect(term.options).toEqual({
      scrollback: 10_000,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
    });
  });

  it("disables WebGL for suppressed keyboards and Apple mobile Safari", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPad) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    });

    expect(shouldDisableWebglRenderer(false)).toBe(true);
    expect(shouldDisableWebglRenderer(true)).toBe(true);
  });

  it("accepts only addons with a disposable lifecycle", () => {
    const addon = { dispose: vi.fn() };

    expect(toDisposableWebglAddon(addon)).toBe(addon);
    expect(toDisposableWebglAddon({ dispose: true })).toBeNull();
    expect(toDisposableWebglAddon(null)).toBeNull();
  });

  it("describes websocket states without exposing implementation objects", () => {
    vi.stubGlobal("WebSocket", { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

    expect(describeReadyState(null)).toBe("null");
    expect(describeReadyState({ readyState: 1 } as WebSocket)).toBe("OPEN");
    expect(describeReadyState({ readyState: 9 } as WebSocket)).toBe("UNKNOWN(9)");
  });
});
