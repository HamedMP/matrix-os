// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paneGridSpy = vi.fn();
const { terminalSettingsState } = vi.hoisted(() => ({
  terminalSettingsState: {
    appThemeId: "matrix-dark",
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: true,
    cursorBlink: true,
    setAppThemeId: vi.fn(),
    setThemeId: vi.fn(),
    setFontSize: vi.fn(),
    setFontFamily: vi.fn(),
    setLigatures: vi.fn(),
    setCursorStyle: vi.fn(),
    setSmoothScroll: vi.fn(),
    setCursorBlink: vi.fn(),
  },
}));

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: (props: unknown) => {
    paneGridSpy(props);
    return <div data-testid="terminal-pane-grid" />;
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    name: "matrix-dark",
    mode: "dark",
    colors: { background: "#1C2019", foreground: "#F0EFE5", primary: "#9CB77A" },
    fonts: { mono: "JetBrains Mono, monospace", sans: "Inter, system-ui, sans-serif" },
    radius: "0.75rem",
  }),
  saveTheme: vi.fn(async () => {}),
}));

vi.mock("@/stores/terminal-settings", () => {
  const useTerminalSettings = (selector: (value: typeof terminalSettingsState) => unknown) => selector(terminalSettingsState);
  useTerminalSettings.getState = () => terminalSettingsState;

  return {
    TERMINAL_FONT_FAMILIES: ["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"],
    DEFAULT_TERMINAL_THEME_ID: "dark",
    DEFAULT_TERMINAL_APP_THEME_ID: "matrix-dark",
    useTerminalSettings,
  };
});

import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function setThemeStyle(style: string) {
  document.documentElement.setAttribute("data-theme-style", style);
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => mockJsonResponse(body, status),
  } as Response;
}

async function flushAsync(times = 3) {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("TerminalApp per-design interior chrome", () => {
  beforeEach(() => {
    paneGridSpy.mockReset();
    terminalSettingsState.appThemeId = "matrix-dark";
    terminalSettingsState.themeId = "system";
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve(mockJsonResponse([]));
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve(mockJsonResponse({ name: "quiet-river" }));
      }
      return Promise.resolve(mockJsonResponse({}));
    }));
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme-style");
    vi.useRealTimers();
  });

  it("keeps the default interior when no OS design is active", async () => {
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    const root = screen.getByRole("application", { name: "Terminal" });
    expect(root.getAttribute("data-terminal-design")).toBe("default");
    expect(screen.queryByRole("tablist", { name: "Terminal tabs" })).toBeNull();
    expect(screen.queryByTestId("terminal-design-tabstrip")).toBeNull();
  });

  it("keeps the default interior under the neumorphic design", async () => {
    setThemeStyle("neumorphic");
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    const root = screen.getByRole("application", { name: "Terminal" });
    expect(root.getAttribute("data-terminal-design")).toBe("default");
    expect(screen.queryByRole("tablist", { name: "Terminal tabs" })).toBeNull();
  });

  it("renders the XP raised tab strip and cmd.exe content colors under winxp", async () => {
    setThemeStyle("winxp");
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    const root = screen.getByRole("application", { name: "Terminal" });
    expect(root.getAttribute("data-terminal-design")).toBe("winxp");

    const strip = screen.getByTestId("terminal-design-tabstrip");
    expect(strip.getAttribute("data-design")).toBe("winxp");
    expect(screen.getByRole("tablist", { name: "Terminal tabs" })).toBeTruthy();

    const contentSurface = screen.getByTestId("terminal-content-surface");
    expect(contentSurface.style.background).toBe("rgb(12, 12, 12)");

    const gridProps = paneGridSpy.mock.lastCall?.[0] as {
      theme: { colors: Record<string, string>; fonts: Record<string, string> };
    };
    expect(gridProps.theme.colors.background).toBe("#0C0C0C");
    expect(gridProps.theme.colors.foreground).toBe("#CCCCCC");
    expect(gridProps.theme.fonts.mono).toBe('"Lucida Console", monospace');
  });

  it("does not render the design tab strip on mobile even under winxp", async () => {
    setThemeStyle("winxp");
    render(<TerminalApp mobile initialSessionId="canvas-session-123" />);
    await flushAsync();

    expect(screen.queryByTestId("terminal-design-tabstrip")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Terminal tabs" })).toBeNull();
  });

  it("renders the Windows Terminal acrylic strip under win11 without recoloring content", async () => {
    setThemeStyle("win11");
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    const root = screen.getByRole("application", { name: "Terminal" });
    expect(root.getAttribute("data-terminal-design")).toBe("win11");

    const strip = screen.getByTestId("terminal-design-tabstrip");
    expect(strip.getAttribute("data-design")).toBe("win11");
    expect(screen.getByRole("button", { name: "New tab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open tab list" })).toBeTruthy();

    // Terminal content keeps the existing system-theme rendering.
    const contentSurface = screen.getByTestId("terminal-content-surface");
    expect(contentSurface.style.background).toBe("rgb(28, 32, 25)");
    const gridProps = paneGridSpy.mock.lastCall?.[0] as {
      theme: { colors: Record<string, string> };
    };
    expect(gridProps.theme.colors.background).toBe("#1C2019");
  });

  it("renders the minimal glass strip under macos-glass with a light translucent content surface", async () => {
    setThemeStyle("macos-glass");
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    const root = screen.getByRole("application", { name: "Terminal" });
    expect(root.getAttribute("data-terminal-design")).toBe("macos-glass");

    const strip = screen.getByTestId("terminal-design-tabstrip");
    expect(strip.getAttribute("data-design")).toBe("macos-glass");
    expect(screen.getByRole("button", { name: "New tab" })).toBeTruthy();
    // The chevron tab-list menu is a Windows Terminal affordance only.
    expect(screen.queryByRole("button", { name: "Open tab list" })).toBeNull();

    const contentSurface = screen.getByTestId("terminal-content-surface");
    expect(contentSurface.style.background).toContain("rgba(245, 245, 247");
  });

  it("activates, creates, and closes tabs from the design tab strip", async () => {
    setThemeStyle("win11");
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    const tablist = screen.getByRole("tablist", { name: "Terminal tabs" });
    const canvasTab = within(tablist).getByRole("tab", { name: "Canvas Terminal" });
    expect(canvasTab.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      await Promise.resolve();
    });
    await flushAsync();

    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => (
      String(input).includes("/api/terminal/sessions") && init?.method === "POST"
    ))).toBe(true);

    const shellTab = within(tablist).getByRole("tab", { name: "Shell" });
    expect(shellTab.getAttribute("aria-selected")).toBe("true");
    expect(canvasTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(canvasTab);
    expect(canvasTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(tablist).getByRole("button", { name: "Close Canvas Terminal" }));
    expect(within(tablist).queryByRole("tab", { name: "Canvas Terminal" })).toBeNull();
    expect(within(tablist).getByRole("tab", { name: "Shell" }).getAttribute("aria-selected")).toBe("true");
  });

  it("lists and activates open tabs from the win11 chevron menu", async () => {
    setThemeStyle("win11");
    render(<TerminalApp initialSessionId="canvas-session-123" />);
    await flushAsync();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      await Promise.resolve();
    });
    await flushAsync();

    const chevron = screen.getByRole("button", { name: "Open tab list" });
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu", { name: "Open tabs" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["Canvas Terminal", "Shell"]);
    expect(items[1].getAttribute("aria-checked")).toBe("true");

    fireEvent.click(items[0]);
    expect(screen.queryByRole("menu", { name: "Open tabs" })).toBeNull();
    const tablist = screen.getByRole("tablist", { name: "Terminal tabs" });
    expect(within(tablist).getByRole("tab", { name: "Canvas Terminal" }).getAttribute("aria-selected")).toBe("true");
  });
});
