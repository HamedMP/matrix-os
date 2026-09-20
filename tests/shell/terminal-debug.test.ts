// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTerminalDebugEnabled } from "../../shell/src/lib/terminal-debug.js";

describe("isTerminalDebugEnabled", () => {
  let storage: { getItem: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    storage = {
      getItem: vi.fn(() => null),
    };
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("enables terminal debug via localStorage", () => {
    storage.getItem.mockImplementation((key: string) => (
      key === "matrix-terminal-debug" ? "1" : null
    ));

    expect(isTerminalDebugEnabled()).toBe(true);
  });

  it("enables terminal debug via query string", () => {
    window.history.replaceState({}, "", "/?terminalDebug=1");

    expect(isTerminalDebugEnabled()).toBe(true);
  });

  it("stays disabled when neither flag is present", () => {
    expect(isTerminalDebugEnabled()).toBe(false);
  });
});
