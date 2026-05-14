// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY,
  loadBrowserMobileShellState,
  parseBrowserMobileShellState,
  saveBrowserMobileShellState,
} from "../../shell/src/stores/mobile-shell-store.js";

describe("browser mobile shell state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("parses valid browser mobile shell state", () => {
    expect(parseBrowserMobileShellState({
      surface: "browser-shell",
      mode: "terminal",
      lastActiveAppSlug: "task-manager",
      lastActiveTerminalSessionId: "550e8400-e29b-41d4-a716-446655440000",
      canvasEnteredAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    })).toMatchObject({
      surface: "browser-shell",
      mode: "terminal",
      lastActiveAppSlug: "task-manager",
      lastActiveTerminalSessionId: "550e8400-e29b-41d4-a716-446655440000",
      canvasEnteredAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
  });

  it("drops unsafe browser persisted state", () => {
    expect(parseBrowserMobileShellState({
      surface: "native-mobile",
      mode: "desktop",
      lastActiveAppSlug: "../../secrets",
      lastActiveTerminalSessionId: "/var/run/socket",
      canvasEnteredAt: "invalid",
      updatedAt: "invalid",
    })).toMatchObject({
      surface: "browser-shell",
      mode: "launcher",
      lastActiveAppSlug: null,
      lastActiveTerminalSessionId: null,
      canvasEnteredAt: null,
    });
  });

  it("uses the canonical app slug validator", () => {
    expect(parseBrowserMobileShellState({
      mode: "app",
      lastActiveAppSlug: "my_app",
      updatedAt: "2026-05-12T00:01:00.000Z",
    })).toMatchObject({
      mode: "app",
      lastActiveAppSlug: null,
    });
  });

  it("loads state from local storage", () => {
    localStorage.setItem(BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY, JSON.stringify({
      mode: "app",
      lastActiveAppSlug: "notes",
      updatedAt: "2026-05-12T00:01:00.000Z",
    }));

    expect(loadBrowserMobileShellState()).toMatchObject({
      surface: "browser-shell",
      mode: "app",
      lastActiveAppSlug: "notes",
    });
  });

  it("falls back when local storage cannot be parsed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY, "{not-json");

    expect(loadBrowserMobileShellState()).toMatchObject({
      surface: "browser-shell",
      mode: "launcher",
    });
    expect(warnSpy).toHaveBeenCalledWith("[shell] failed to load mobile shell state", expect.any(SyntaxError));

    warnSpy.mockRestore();
  });

  it("saves sanitized state to local storage", () => {
    saveBrowserMobileShellState({
      surface: "browser-shell",
      mode: "app",
      lastActiveAppSlug: "../secrets",
      lastActiveTerminalSessionId: "terminal_123",
      canvasEnteredAt: null,
      updatedAt: "invalid",
    });

    const saved = JSON.parse(localStorage.getItem(BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY) ?? "{}");
    expect(saved).toMatchObject({
      surface: "browser-shell",
      mode: "app",
      lastActiveAppSlug: null,
      lastActiveTerminalSessionId: null,
    });
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  });
});
