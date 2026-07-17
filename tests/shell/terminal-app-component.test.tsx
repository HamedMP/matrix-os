// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const CANONICAL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

const paneGridSpy = vi.fn();
const { saveThemeSpy, terminalSettingsState } = vi.hoisted(() => ({
  saveThemeSpy: vi.fn(async () => {}),
  terminalSettingsState: {
    appThemeId: "matrix-dark",
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: true,
    cursorBlink: true,
    setAppThemeId: vi.fn((appThemeId: string) => {
      terminalSettingsState.appThemeId = appThemeId;
    }),
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
  saveTheme: saveThemeSpy,
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
import { getTerminalThemePreset } from "../../shell/src/components/terminal/terminal-themes.js";

function normalizeCssColor(color: string) {
  const element = document.createElement("div");
  element.style.background = color;
  return element.style.background;
}

const expectedDarkTerminalBackground = normalizeCssColor(getTerminalThemePreset("dark").background);

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

async function openNewSessionMenu() {
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  await Promise.resolve();
}

async function chooseNewSessionMenuItem(name: RegExp | string) {
  await openNewSessionMenu();
  const menu = screen.getByRole("menu", { name: "New session menu" });
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  await Promise.resolve();
  await Promise.resolve();
}

async function chooseNewSessionMenuItemAfterStatus(name: RegExp | string) {
  await openNewSessionMenu();
  const menu = screen.getByRole("menu", { name: "New session menu" });
  const item = await vi.waitFor(() => within(menu).getByRole("menuitem", { name }));
  fireEvent.click(item);
  await vi.waitFor(() => {
    expect(screen.queryByRole("menu", { name: "New session menu" })).toBeNull();
  });
}

function expectOptimizedImageSrc(element: HTMLElement, expectedPath: string): void {
  expect(decodeURIComponent(element.getAttribute("src") ?? "")).toContain(expectedPath);
}

function terminalSessionPostBodies(): string[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => String(input).includes("/api/terminal/sessions") && init?.method === "POST")
    .map(([, init]) => String(init?.body ?? ""));
}

function createDragDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "move",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn((format?: string) => {
      if (format) {
        data.delete(format);
      } else {
        data.clear();
      }
    }),
    getData: vi.fn((format: string) => data.get(format) ?? ""),
    setData: vi.fn((format: string, value: string) => {
      data.set(format, value);
    }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function revealSessionActions(name: string) {
  const card = screen.getByTestId(`terminal-session-card-${name}`);
  fireEvent.pointerEnter(card);
  fireEvent.pointerMove(card);
  fireEvent.mouseEnter(card);
  fireEvent.mouseMove(card);
}

async function openSessionContextMenu(name: string, displayName = `matrix-${name}`) {
  const existingMenu = screen.queryByRole("menu", { name: `Actions for ${displayName}` });
  if (existingMenu) return existingMenu;
  revealSessionActions(name);
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${displayName}` }));
  await Promise.resolve();
  await Promise.resolve();
  return screen.getByRole("menu", { name: `Actions for ${displayName}` });
}

describe("TerminalApp", () => {
  beforeEach(() => {
    paneGridSpy.mockReset();
    saveThemeSpy.mockClear();
    terminalSettingsState.appThemeId = "matrix-dark";
    terminalSettingsState.themeId = "system";
    terminalSettingsState.setAppThemeId.mockClear();
    terminalSettingsState.setThemeId.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a canvas-provided terminal session without creating a fresh layout tab", async () => {
    render(<TerminalApp initialSessionId="canvas-session-123" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };

    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "canvas-session-123",
    });
    expect((props.paneTree as { compatMode?: string }).compatMode).toBeUndefined();
  });

  it("marks canvas-provided Codex shell sessions for Codex TUI compatibility", async () => {
    render(<TerminalApp initialSessionId="codex-backend" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string; compatMode?: string };
    };

    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "codex-backend",
      compatMode: "codex-tui",
    });
  });

  it("marks restored codex-* shell sessions for Codex TUI compatibility", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            activeTabId: "tab-codex",
            tabs: [
              {
                id: "tab-codex",
                label: "codex-backend",
                paneTree: { type: "pane", id: "pane-codex", cwd: "projects", sessionId: "codex-backend" },
              },
            ],
          }),
        });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "codex-backend", status: "active" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string; compatMode?: string };
    };

    expect(props.paneTree).toMatchObject({
      sessionId: "codex-backend",
      compatMode: "codex-tui",
    });
  });

  it("renders the desktop terminal pane grid flush without an inset content frame", async () => {
    render(<TerminalApp initialSessionId="canvas-session-123" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-pane-grid")).toBeTruthy();
    const contentSurface = screen.getByTestId("terminal-content-surface");

    expect(contentSurface).toBeInstanceOf(HTMLElement);
    expect(contentSurface.style.padding).toBe("0px");
    expect(contentSurface.style.background).toBe("rgb(28, 32, 25)");
  });

  it("uses the selected non-system terminal theme background for the flush content surface", async () => {
    terminalSettingsState.themeId = "dark";

    render(<TerminalApp initialSessionId="canvas-session-123" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const contentSurface = screen.getByTestId("terminal-content-surface");

    expect(contentSurface.style.padding).toBe("0px");
    expect(contentSurface.style.background).toBe(expectedDarkTerminalBackground);
  });

  it("does not immediately save after hydrating a saved terminal layout", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            activeTabId: "tab-saved",
            sidebarOpen: true,
            tabs: [{
              id: "tab-saved",
              label: "Saved",
              paneTree: { type: "pane", id: "pane-saved", cwd: "projects/app" },
            }],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const layoutPutCalls = fetchMock.mock.calls.filter((call) => (
      String(call[0]).includes("/api/terminal/layout") && call[1]?.method === "PUT"
    ));
    expect(layoutPutCalls).toHaveLength(0);
  });

  it("does not render workspace transport ids as managed shell sessions", async () => {
    render(<TerminalApp initialSessionId="matrix-sess_run_db0dded67faaca6b" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("matrix-sess_run_db0dded67faaca6b")).toBeNull();
    expect(screen.queryByRole("button", { name: /close matrix-sess_run_db0dded67faaca6b/i })).toBeNull();
  });

  it("does not render desktop terminal traffic lights from the removed top chrome", async () => {
    const close = vi.fn();
    const minimize = vi.fn();
    const toggleFullscreen = vi.fn();
    render(<TerminalApp windowControls={{ close, minimize, toggleFullscreen }} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Close Terminal window" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Minimize Terminal window" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle Terminal fullscreen" })).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(minimize).not.toHaveBeenCalled();
    expect(toggleFullscreen).not.toHaveBeenCalled();
  });

  it("keeps the mobile terminal chrome clear of cwd badges that overlap zellij tabs", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("~/projects")).toBeNull();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  });

  it("keeps mobile terminal accessory keys theme-aligned and keyboard safe", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const keyBar = screen.getByTestId("terminal-key-bar");
    expect(keyBar.style.position).toBe("sticky");
    expect(keyBar.style.bottom).toBe("0px");
    expect(document.documentElement.style.getPropertyValue("--terminal-keyboard-height")).toBe("");
    expect(keyBar.style.background).toBe("var(--mtk-bg)");
    expect(keyBar.style.getPropertyValue("--mtk-bg")).toBe("#15180F");
    expect(keyBar.style.getPropertyValue("--mtk-fg")).toBe("#C9C7B7");
    expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
  });

  it("marks mobile terminal input active while the command composer is focused", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const root = screen.getByRole("application", { name: "Terminal" });
    const composer = screen.getByRole("textbox", { name: "Command composer" });

    expect(root.getAttribute("data-terminal-input-active")).toBe("false");
    expect(screen.getByRole("button", { name: "Show more keys" })).toBeTruthy();

    fireEvent.focus(composer);

    expect(root.getAttribute("data-terminal-input-active")).toBe("true");
    expect(screen.queryByRole("button", { name: "Show more keys" })).toBeNull();

    fireEvent.blur(composer);

    expect(root.getAttribute("data-terminal-input-active")).toBe("false");
    expect(screen.getByRole("button", { name: "Show more keys" })).toBeTruthy();
  });

  it("does not let mobile terminal clients take ownership of the remote zellij size", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      allowRemoteResize: false,
      suppressNativeKeyboard: true,
    });
  });

  it("renders the redesigned desktop shell with sessions in the drawer instead of top tabs", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("tablist", { name: "Terminal tabs" })).toBeNull();
    expect(screen.getByText("matrix os")).toBeTruthy();
    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Background")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByText("Zellij")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split right" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Split down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Terminal window" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Minimize Terminal window" })).toBeNull();
  });

  it("collapses and expands the Background session group accessibly", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", tabs: [] },
              { name: "docs", status: "active", placement: "background", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const toggle = screen.getByRole("button", { name: "Toggle Background sessions" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("terminal-session-group-background-content");
    expect(screen.getByTestId("terminal-session-card-docs")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const controlledRegion = document.getElementById("terminal-session-group-background-content");
    expect(controlledRegion).toBeTruthy();
    expect(controlledRegion?.hidden).toBe(true);
    expect(screen.queryByTestId("terminal-session-card-docs")).toBeNull();
    expect(screen.queryByText("Nothing running in background")).toBeNull();
    expect(screen.getByTestId("terminal-session-background-chevron").style.transform).toBe("rotate(0deg)");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("terminal-session-card-docs")).toBeTruthy();
  });

  it("sizes the drawer header logo against the title block", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const logo = screen.getByTestId("terminal-expanded-brand");
    const mask = screen.getByTestId("terminal-expanded-brand-mask");
    expect(logo.style.alignSelf).toBe("center");
    expect(logo.style.height).toBe("38px");
    expect(logo.style.width).toBe("38px");
    expect(mask.style.height).toBe("22px");
    expect(mask.style.width).toBe("22px");

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const collapsedLogo = screen.getByTestId("terminal-collapsed-brand");
    const collapsedMask = screen.getByTestId("terminal-collapsed-brand-mask");
    expect(screen.getByTestId("terminal-collapsed-rail").style.width).toBe("76px");
    expect(collapsedLogo.style.width).toBe("40px");
    expect(collapsedLogo.style.height).toBe("40px");
    expect(collapsedMask.style.width).toBe("22px");
    expect(collapsedMask.style.height).toBe("22px");
  });

  it("opens terminal-only app theme menu without Match system or global Matrix OS theme controls", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();

    const button = screen.getByRole("button", { name: "Theme" });
    const footer = screen.getByTestId("terminal-sidebar-footer");
    expect(within(footer).getByRole("button", { name: "Theme" })).toBe(button);
    expect(footer.style.justifyContent).toBe("flex-start");
    expect(footer.style.borderTop).toBe("1px solid var(--terminal-drawer-border)");
    expect(button.textContent?.replace(/\s+/g, "")).toBe("☼Theme");
    expect(button.style.height).toBe("34px");
    expect(button.style.borderRadius).toBe("9px");
    expect(button.style.background).toBe("var(--terminal-drawer-button-bg)");
    expect(button.getAttribute("style")).toContain("border-color: var(--terminal-drawer-button-border)");

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));
    expect(screen.queryByRole("button", { name: "Theme" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand sessions drawer" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("menu", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("menu", { name: "Theme" }).style.bottom).toBe("100%");
    expect(screen.getByRole("menu", { name: "Theme" }).style.left).toBe("0px");
    expect(screen.getByRole("menu", { name: "Theme" }).style.top).toBe("auto");
    expect(screen.getByText("Warm paper")).toBeTruthy();
    expect(screen.getByText("Warm dark")).toBeTruthy();
    expect(screen.getByText("Phosphor green")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Light Warm paper" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Matrix OS Dark Warm dark" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Matrix Phosphor green" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Change shell theme Advanced terminal colors" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Match system" })).toBeNull();
    expect(screen.queryByText("Match system")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Shell theme" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    expect(saveThemeSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions/main/preferences"),
      expect.anything(),
    );

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });

    expect(screen.queryByRole("menu", { name: "Theme" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("terminal-scopes the sessions drawer scrollbar and resize boundary", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const scrollSurface = screen.getByTestId("terminal-sessions-scroll");
    expect(scrollSurface.classList.contains("terminal-sessions-scroll")).toBe(true);
    expect(scrollSurface.getAttribute("data-terminal-scrollbar")).toBe("drawer");

    const resizeHandle = screen.getByRole("button", { name: "Resize sessions drawer" });
    expect(resizeHandle.classList.contains("terminal-drawer-resize-handle")).toBe(true);
    expect(resizeHandle.style.background).toBe("var(--terminal-drawer-resize-handle-bg)");
    expect(resizeHandle.style.outline).toBe("none");
    expect(resizeHandle.getAttribute("style")).toContain("--terminal-drawer-resize-handle-bg");
    expect(resizeHandle.getAttribute("style")).not.toContain("--muted-foreground");

    const terminalApp = screen.getByRole("application", { name: "Terminal" });
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-resize-handle-bg")).toContain("--terminal-drawer-border");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-resize-handle-hover")).toBe("var(--terminal-drawer-border)");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-scrollbar-thumb")).toContain("--terminal-drawer-border");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-scrollbar-thumb-hover")).toBe("var(--terminal-drawer-border)");

  });

  it("updates terminal app theme without saving the global Matrix OS theme", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Light Warm paper" }));
      await Promise.resolve();
    });

    expect(terminalSettingsState.setAppThemeId).toHaveBeenCalledWith("light");
    expect(terminalSettingsState.appThemeId).toBe("light");
    expect(terminalSettingsState.setThemeId).not.toHaveBeenCalled();
    expect(saveThemeSpy).not.toHaveBeenCalled();
  });

  it("applies terminal app theme to Terminal chrome without changing shell colors", async () => {
    terminalSettingsState.themeId = "dark";
    const view = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    let terminalApp = screen.getByRole("application", { name: "Terminal" });
    const contentSurface = screen.getByTestId("terminal-content-surface");
    expect(contentSurface.style.background).toBe(expectedDarkTerminalBackground);
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-bg")).toBe("#15180F");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-card-bg")).toBe("#20241C");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Light Warm paper" }));
      await Promise.resolve();
    });
    view.rerender(<TerminalApp />);

    terminalApp = screen.getByRole("application", { name: "Terminal" });
    expect(terminalSettingsState.appThemeId).toBe("light");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-bg")).toBe("#E9E9D8");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-card-bg")).toBe("#FFFDF7");
    expect(screen.getByTestId("terminal-sidebar-shell").style.background).toBe("var(--terminal-drawer-bg)");
    expect(screen.getByTestId("terminal-session-card-main").style.background).toBe("var(--terminal-drawer-card-bg)");
    expect(screen.getByTestId("terminal-content-surface").style.background).toBe(expectedDarkTerminalBackground);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Matrix Phosphor green" }));
      await Promise.resolve();
    });
    view.rerender(<TerminalApp />);

    terminalApp = screen.getByRole("application", { name: "Terminal" });
    expect(terminalSettingsState.appThemeId).toBe("matrix");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-bg")).toBe("#08110B");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-card-bg")).toBe("#0F1A12");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-fg")).toBe("#9BFFB5");
    expect(screen.getByTestId("terminal-session-name-main").style.color).toBe("var(--terminal-drawer-fg)");
    expect(screen.getByTestId("terminal-content-surface").style.background).toBe(expectedDarkTerminalBackground);
    expect(terminalSettingsState.setThemeId).not.toHaveBeenCalled();
    expect(saveThemeSpy).not.toHaveBeenCalled();
  });

  it("opens advanced shell theme chooser and saves global terminal shell theme", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Theme" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("menu", { name: "Theme" })).toBeTruthy();
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Change shell theme Advanced terminal colors" }));
      await Promise.resolve();
    });

    expect(screen.queryByRole("dialog", { name: "Shell theme" })).toBeNull();
    expect(screen.queryByRole("menu", { name: "Theme" })).toBeNull();
    expect(screen.getByRole("region", { name: "Shell theme" })).toBeTruthy();
    const shellThemePanel = screen.getByTestId("terminal-shell-theme-panel");
    expect(shellThemePanel).toBeTruthy();
    expect(shellThemePanel.style.bottom).toBe("100%");
    expect(shellThemePanel.style.left).toBe("0px");
    expect(shellThemePanel.style.right).toBe("auto");
    expect(shellThemePanel.style.top).toBe("auto");
    expect(shellThemePanel.style.width).toBe("280px");
    expect(shellThemePanel.style.maxWidth).toBe("calc(100vw - 24px)");
    expect(screen.getByRole("button", { name: "Back to theme menu" })).toBeTruthy();
    expect(screen.getByText("Zellij default · best contrast")).toBeTruthy();
    expect(screen.getByText("gruvbox-light")).toBeTruthy();
    expect(screen.getByText("custom · green on black")).toBeTruthy();
    expect(screen.getAllByText("NOT FULLY TUNED")).toHaveLength(2);
    expect(shellThemePanel.style.animation).toContain("terminalShellThemePanelIn");
    expect(screen.getByText("RECOMMENDED").style.fontSize).toBe("8px");
    expect(screen.getByText("RECOMMENDED").style.animation).toContain("terminalShellThemeBadgeIn");
    expect(screen.getByText("RECOMMENDED").parentElement?.style.justifyContent).toBe("flex-end");
    expect(screen.getByText("RECOMMENDED").parentElement?.style.minWidth).toBe("86px");
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    expect(saveThemeSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions/main/preferences"),
      expect.anything(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to theme menu" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("menu", { name: "Theme" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Shell theme" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Change shell theme Advanced terminal colors" }));
      await Promise.resolve();
    });

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Light gruvbox-light" }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/preferences"),
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("\"shellThemeId\":\"light\""),
      }),
    );
  });

  it("copies Matrix shell connect commands from session rows", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("matrix shell connect")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Command" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Matrix shell connect command for matrix-main" })).toBeNull();
    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    const actions = screen.getByTestId("terminal-session-actions-main");
    expect(row!.style.display).toBe("grid");
    expect(row!.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(actions.style.position).toBe("absolute");
    expect(actions.style.right).toBe("-8px");
    expect(actions.style.top).toBe("50%");
    expect(actions.style.transform).toBe("translateY(-50%)");
    expect(screen.queryByText("matrix shell connect")).toBeNull();
    expect(actions.style.maxHeight).toBe("");
    expect(within(actions).getByRole("button", { name: "Rename matrix-main" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "More actions for matrix-main" })).toBeTruthy();
    expect(within(actions).queryByRole("button", { name: "Copy Command" })).toBeNull();
    expect(within(actions).queryByRole("button", { name: "Close" })).toBeNull();

    let menu = await openSessionContextMenu("main");
    const moveButton = within(menu).getByRole("menuitem", { name: "Move to Background" });
    expect(moveButton).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Close" })).toBeTruthy();
    expect(document.activeElement).toBe(moveButton);

    fireEvent.keyDown(moveButton, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Actions for matrix-main" })).toBeNull();
    expect(document.activeElement).toBe(within(actions).getByRole("button", { name: "More actions for matrix-main" }));

    menu = await openSessionContextMenu("main");
    const copyButton = within(menu).getByRole("menuitem", { name: "Copy Command" });
    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("matrix shell connect main");
    expect(screen.queryByRole("menu", { name: "Actions for matrix-main" })).toBeNull();
    expect(document.activeElement).toBe(within(actions).getByRole("button", { name: "More actions for matrix-main" }));
    const copyFeedback = screen.getByTestId("terminal-session-copy-toast-main");
    expect(copyFeedback.textContent).toContain("Copied");
    expect(copyFeedback.className).not.toContain("sr-only");
    expect(copyFeedback.style.display).toBe("inline-flex");
    expect(within(actions).queryByText("matrix shell connect")).toBeNull();
  });

  it("keeps session action menu above later session cards", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", attachedClients: 0, tabs: [{ idx: 0, name: "docs", focused: true }] },
              { name: "bench", status: "idle", placement: "active", attachCommand: "mos shell attach bench", attachedClients: 0, tabs: [{ idx: 0, name: "bench", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const mainCard = screen.getByTestId("terminal-session-card-main");
    const docsCard = screen.getByTestId("terminal-session-card-docs");
    const benchCard = screen.getByTestId("terminal-session-card-bench");

    await openSessionContextMenu("main");

    expect(screen.getByRole("menu", { name: "Actions for matrix-main" })).toBeTruthy();
    expect(Number(mainCard.style.zIndex)).toBeGreaterThan(Number(docsCard.style.zIndex || "0"));
    expect(Number(mainCard.style.zIndex)).toBeGreaterThan(Number(benchCard.style.zIndex || "0"));
    expect(docsCard.style.transform).toBe("");
    expect(benchCard.style.transform).toBe("");
  });

  it("copies with the synchronous selection fallback and still shows the Paper copy confirmation", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openSessionContextMenu("main");

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Command" }));
      await Promise.resolve();
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByTestId("terminal-session-copy-toast-main").textContent).toContain("Copied");
  });

  it("falls back to the Clipboard API when legacy copy returns false", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openSessionContextMenu("main");

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Command" }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).toHaveBeenCalledWith("matrix shell connect main");
    expect(screen.getByTestId("terminal-session-copy-toast-main").textContent).toContain("Copied");
  });

  it("reorders active shell sessions with the Paper drag affordance", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/order") && init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
              { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
              { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const getOrder = () => Array.from(screen.getByTestId("terminal-session-group-active").querySelectorAll("[data-session-name]"))
      .map((node) => node.getAttribute("data-session-name"));
    expect(getOrder()).toEqual(["main", "review", "docs"]);

    const dataTransfer = createDragDataTransfer();
    const mainHandle = screen.getByRole("button", { name: "Drag matrix-main session" });
    fireEvent.mouseEnter(screen.getByTestId("terminal-session-card-main"));
    fireEvent.dragStart(mainHandle, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });

    expect(screen.getByTestId("terminal-session-drop-line-docs")).toBeTruthy();

    await act(async () => {
      fireEvent.drop(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const orderCall = calls.find((call) => call.url.endsWith("/api/terminal/sessions/order") && call.init?.method === "PUT");
    expect(orderCall).toBeTruthy();
    expect(JSON.parse(String(orderCall?.init?.body))).toEqual({ order: ["review", "docs", "main"] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["docs", "review", "main"]);
  });

  it("clears stale Shells state when reorder returns an authoritative session list", async () => {
    let sessionListMode: "initial" | "fail" = "initial";
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/order") && init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
              { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        if (sessionListMode === "fail") {
          return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
              { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
              { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const getOrder = () => Array.from(screen.getByTestId("terminal-session-group-active").querySelectorAll("[data-session-name]"))
      .map((node) => node.getAttribute("data-session-name"));
    expect(getOrder()).toEqual(["main", "review", "docs"]);

    sessionListMode = "fail";
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-sessions-stale-label").textContent).toContain("Terminal session data is stale");

    const dataTransfer = createDragDataTransfer();
    fireEvent.mouseEnter(screen.getByTestId("terminal-session-card-main"));
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag matrix-main session" }), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });

    await act(async () => {
      fireEvent.drop(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getOrder()).toEqual(["docs", "review", "main"]);
    expect(screen.queryByTestId("terminal-sessions-stale-label")).toBeNull();
  });

  it("keeps an optimistic shell reorder visible while polling returns the old order", async () => {
    let shellList = [
      { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
      { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
      { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
    ];
    let resolveOrder: ((value: Response) => void) | undefined;
    const orderPromise = new Promise<Response>((resolve) => {
      resolveOrder = resolve;
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/order") && init?.method === "PUT") {
        return orderPromise;
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeGroup = screen.getByTestId("terminal-session-group-active");
    const getOrder = () => Array.from(activeGroup.querySelectorAll("[data-session-name]"))
      .map((node) => node.getAttribute("data-session-name"));
    expect(getOrder()).toEqual(["main", "review", "docs"]);

    const dataTransfer = createDragDataTransfer();
    fireEvent.mouseEnter(screen.getByTestId("terminal-session-card-main"));
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag matrix-main session" }), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });

    await act(async () => {
      fireEvent.drop(screen.getByTestId("terminal-session-card-docs"), { dataTransfer });
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["review", "docs", "main"]);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["review", "docs", "main"]);

    shellList = [
      { name: "docs", status: "active", placement: "active", attachCommand: "mos shell attach docs", tabs: [] },
      { name: "review", status: "active", placement: "active", attachCommand: "mos shell attach review", tabs: [] },
      { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", tabs: [] },
    ];
    await act(async () => {
      resolveOrder?.({
        ok: true,
        json: async () => ({ sessions: shellList }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getOrder()).toEqual(["docs", "review", "main"]);
  });

  it("renames sessions from the Paper pencil affordance", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/main/rename") && init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            session: {
              name: "review-main",
              status: "active",
              placement: "active",
              attachCommand: "mos shell attach review-main",
              attachedClients: 1,
              tabs: [{ idx: 0, name: "main", focused: true }],
            },
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    expect(row!.style.display).toBe("grid");
    expect(screen.getByRole("button", { name: "Open matrix-main" }).style.minWidth).toBe("0px");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename matrix-main" }));
      await Promise.resolve();
    });

    let input = screen.getByRole("textbox", { name: "Session name for matrix-main" });
    expect(screen.queryByRole("button", { name: "Rename matrix-main" })).toBeNull();
    await act(async () => {
      fireEvent.pointerDown(document.body);
      await Promise.resolve();
    });
    expect(screen.queryByRole("textbox", { name: "Session name for matrix-main" })).toBeNull();

    fireEvent.mouseEnter(row!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename matrix-main" }));
      await Promise.resolve();
    });
    input = screen.getByRole("textbox", { name: "Session name for matrix-main" });
    fireEvent.change(input, { target: { value: "review-main" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Open review-main" })).toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/main/rename"),
        init: expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ name: "review-main" }),
        }),
      }),
    ]));
  });

  it("anchors desktop close confirmation beside the session without dimming the terminal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let deleted = false;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: deleted ? [] : [
              {
                name: "claude-review",
                status: "active",
                placement: "active",
                visualStatus: "finished",
                latestSeq: 2,
                lastSeenSeq: 1,
                unread: true,
                tabs: [{ idx: 0, name: "review", focused: true }],
              },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/claude-review") && init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open claude-review" }).closest<HTMLElement>(".group");
    expect(row).toBeTruthy();
    vi.spyOn(row!, "getBoundingClientRect").mockReturnValue({
      bottom: 316,
      height: 52,
      left: 28,
      right: 360,
      top: 264,
      width: 332,
      x: 28,
      y: 264,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    let menu = await openSessionContextMenu("claude-review", "claude-review");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Close" }));
      await Promise.resolve();
    });

    const dialog = screen.getByRole("dialog", { name: "Close this session?" });
    expect(within(dialog).getByText("Closing ends the session and permanently deletes it and its transcript. You won't be able to reopen or recover it — this can't be undone.")).toBeTruthy();
    expect(within(dialog).getByText("claude-review")).toBeTruthy();
    expect(within(dialog).getByText("active · 1 unread")).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(dialog.dataset.placement).toBe("right");
    expect(dialog.style.position).toBe("fixed");
    expect(dialog.style.left).toBe("372px");
    expect(dialog.style.background).not.toBe("rgba(3, 10, 3, 0.74)");
    const sheet = screen.getByTestId("terminal-close-confirmation-sheet");
    expect(sheet.style.boxShadow).toBe("none");
    expect(sheet.dataset.terminalCloseMotion).toBe("desktop");
    expect(sheet.style.animationName).toBe("terminal-close-popover-in-right");
    expect(sheet.style.animationDuration).toBe("180ms");
    expect(sheet.style.transformOrigin).toBe("left center");
    expect(screen.queryByRole("button", { name: "Cancel close session" })).toBeNull();
    expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "Close this session?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open claude-review" })).toBeTruthy();

    menu = await openSessionContextMenu("claude-review", "claude-review");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Close" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open claude-review" })).toBeNull();
  });

  it("uses the Paper mobile bottom sheet for session close confirmation", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", visualStatus: "idle", unread: false, tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);

    const menu = await openSessionContextMenu("main");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Close" }));
      await Promise.resolve();
    });

    const dialog = screen.getByRole("dialog", { name: "Close this session?" });
    expect(dialog.style.alignItems).toBe("flex-end");
    const sheet = screen.getByTestId("terminal-close-confirmation-sheet");
    expect(sheet.style.borderTopLeftRadius).toBe("26px");
    expect(sheet.style.borderTopRightRadius).toBe("26px");
    expect(dialog.dataset.terminalCloseMotion).toBe("mobile-backdrop");
    expect(dialog.style.animationName).toBe("terminal-close-backdrop-in");
    expect(sheet.dataset.terminalCloseMotion).toBe("mobile-sheet");
    expect(sheet.style.animationName).toBe("terminal-close-sheet-in");
    expect(sheet.style.animationDuration).toBe("220ms");
    expect(within(sheet).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("persists Paper active and background placement toggles through the gateway", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
              { name: "docs", status: "active", placement: "background", latestSeq: 11, lastSeenSeq: 5, unread: true, visualStatus: "idle", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/") && url.endsWith("/ui-state")) {
        return Promise.resolve({ ok: true, json: async () => ({ session: {} }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open docs" })).toBeTruthy();

    let menu = await openSessionContextMenu("main");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to Background" }));
      await Promise.resolve();
    });
    menu = await openSessionContextMenu("docs", "docs");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Make Active" }));
      await Promise.resolve();
    });

    const uiStateCalls = calls.filter((call) => call.url.includes("/ui-state"));
    expect(uiStateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/main/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "background" }) }),
      }),
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/docs/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "active", lastSeenSeq: 11 }) }),
      }),
    ]));
    expect(uiStateCalls.filter((call) => call.url.includes("/api/terminal/sessions/docs/ui-state"))).toHaveLength(1);
  });

  it("opens a shell session when the drawer row surface is clicked", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 7, unread: false, visualStatus: "idle", attachCommand: "mos shell attach main", tabs: [] },
              { name: "docs", status: "active", placement: "background", latestSeq: 11, lastSeenSeq: 5, unread: true, visualStatus: "finished", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/") && url.endsWith("/ui-state")) {
        return Promise.resolve({ ok: true, json: async () => ({ session: {} }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-main").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-session-row-docs"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-main").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("false");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("true");

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/docs/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "active", lastSeenSeq: 11 }) }),
      }),
    ]));
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "docs",
    });
  });

  it("renders Paper status dot colors and pulses only for running sessions", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "running", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 7, unread: false, visualStatus: "running", attachCommand: "mos shell attach running", tabs: [] },
              { name: "finished", status: "active", placement: "active", latestSeq: 9, lastSeenSeq: 4, unread: true, visualStatus: "finished", attachCommand: "mos shell attach finished", tabs: [] },
              { name: "idle", status: "active", placement: "active", latestSeq: 2, lastSeenSeq: 2, unread: false, visualStatus: "idle", attachCommand: "mos shell attach idle", tabs: [] },
              { name: "waiting", status: "active", placement: "background", latestSeq: 3, lastSeenSeq: 3, unread: false, visualStatus: "waiting", attachCommand: "mos shell attach waiting", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const running = screen.getByTestId("terminal-session-status-running");
    const finished = screen.getByTestId("terminal-session-status-finished");
    const idle = screen.getByTestId("terminal-session-status-idle");
    const waiting = screen.getByTestId("terminal-session-status-waiting");

    expect(running.style.background).toBe("rgb(95, 184, 95)");
    expect(running.style.boxShadow).toContain("rgba(95,184,95,0.24)");
    expect(running.classList.contains("terminal-session-status-dot--running")).toBe(true);
    expect(finished.style.background).toBe("rgb(46, 107, 58)");
    expect(finished.style.boxShadow).toBe("none");
    expect(finished.classList.contains("terminal-session-status-dot--running")).toBe(false);
    expect(idle.style.background).toBe("rgb(169, 170, 154)");
    expect(idle.style.boxShadow).toBe("none");
    expect(idle.classList.contains("terminal-session-status-dot--running")).toBe(false);
    expect(waiting.style.background).toBe("rgb(224, 161, 46)");
    expect(waiting.style.boxShadow).toContain("rgba(224,161,46,0.25)");
    expect(waiting.classList.contains("terminal-session-status-dot--running")).toBe(false);
  });

  it("keeps successful session updates when another optimistic UI patch rolls back", async () => {
    let resolveMarkSeen: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/main/ui-state")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { placement?: string; lastSeenSeq?: number };
        if (body.lastSeenSeq === 7 && body.placement === undefined) {
          return new Promise<Response>((resolve) => {
            resolveMarkSeen = resolve;
          });
        }
        if (body.placement === "background") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              session: { name: "main", status: "active", placement: "background", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
            }),
          } as Response);
        }
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
    });
    const menu = await openSessionContextMenu("main");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to Background" }));
      await Promise.resolve();
    });

    expect(within(await openSessionContextMenu("main")).getByRole("menuitem", { name: "Make Active" })).toBeTruthy();
    expect(resolveMarkSeen).toBeDefined();

    await act(async () => {
      resolveMarkSeen?.({ ok: false, json: async () => ({}) } as Response);
      await Promise.resolve();
    });

    expect(within(await openSessionContextMenu("main")).getByRole("menuitem", { name: "Make Active" })).toBeTruthy();
  });

  it("keeps a reopened background shell active when the placement patch fails after attach", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 7, unread: false, visualStatus: "idle", attachCommand: "mos shell attach main", tabs: [] },
              { name: "docs", status: "active", placement: "background", latestSeq: 11, lastSeenSeq: 11, unread: false, visualStatus: "running", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/docs/ui-state")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const docsMenu = await openSessionContextMenu("docs", "docs");
    await act(async () => {
      fireEvent.click(within(docsMenu).getByRole("menuitem", { name: "Make Active" }));
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "docs" },
    });
    expect(within(await openSessionContextMenu("docs", "docs")).getByRole("menuitem", { name: "Move to Background" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make Active" })).toBeNull();
    expect(screen.queryByText("Failed to update session")).toBeNull();
    expect(screen.queryByText("Could not update session")).toBeNull();
    expect(vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions") && init?.method === "POST"
    ))).toHaveLength(0);
    expect(vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/docs?force=1") && init?.method === "DELETE"
    ))).toHaveLength(0);
  });

  it("focuses active shell rows without creating duplicate attached tabs or layout save noise", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockClear();
    const paneRenderCount = paneGridSpy.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.calls).toHaveLength(paneRenderCount);
    const layoutSaveCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));
    expect(layoutSaveCalls).toHaveLength(0);
  });

  it("renders a mobile sessions surface with compact foreground and background toggles", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("matrix-os")).toBeTruthy();
    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to Background" })).toBeNull();
    expect(within(await openSessionContextMenu("main")).getByRole("menuitem", { name: "Move to Background" })).toBeTruthy();
    expect(screen.queryByText("Zellij")).toBeNull();
  });

  it("opens mobile terminal detail with back navigation and command composer", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
    });

    expect(screen.queryByPlaceholderText("Find a session...")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to sessions" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Command composer" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
  });

  it("opens the Paper new-session menu before creating a new session", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await openNewSessionMenu();
    });

    const menu = screen.getByRole("menu", { name: "New session menu" });
    expect(within(menu).getByText("NEW TAB")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /^Shell(?:\s+⌘T)?$/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /^Claude Code(?:\s+⌘⇧C)?$/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /^Codex(?:\s+⌘⇧X)?$/i })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") &&
      init?.method === "POST"
    ))).toBe(false);
  });

  it("keeps the new-session menu visible outside a resized drawer", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await openNewSessionMenu();
    });

    expect(screen.getByRole("menu", { name: "New session menu" })).toBeTruthy();
    expect(screen.getByTestId("terminal-sidebar-shell").style.overflow).toBe("visible");
  });

  it("uses compact new-session menu sizing from the drawer and collapsed rail", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await openNewSessionMenu();
    });

    let menu = screen.getByRole("menu", { name: "New session menu" });
    expect(menu.style.width).toBe("244px");
    expect(menu.style.padding).toBe("8px");
    expect(menu.style.gap).toBe("4px");
    expect(menu.style.right).toBe("0px");
    expect(menu.style.top).toBe("calc(100% + 8px)");
    expect(within(menu).getByRole("menuitem", { name: /^Shell(?:\s+⌘T)?$/i }).style.height).toBe("32px");

    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    menu = screen.getByRole("menu", { name: "New session menu" });
    expect(menu.style.width).toBe("244px");
    expect(menu.style.left).toBe("calc(100% + 8px)");
    expect(menu.style.top).toBe("0px");
  });

  it("opens Matrix-named shell sessions from the new-session menu", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    const createCalls = fetchMock.mock.calls
      .filter(([input, init]: [RequestInfo | URL, RequestInit | undefined]) => (
        String(input).endsWith("/api/terminal/sessions") &&
        init?.method === "POST" &&
        typeof init.body === "string"
      ))
      .map(([, init]: [RequestInfo | URL, RequestInit]) => JSON.parse(String(init.body)) as { name: string });

    const createdShell = createCalls.find((body) => CANONICAL_SESSION_NAME_PATTERN.test(body.name));
    expect(createdShell).toBeTruthy();
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: createdShell?.name,
      },
    });
  });

  it("shows a pending shell row and disables creation controls while a new session is starting", async () => {
    let resolveCreate: (response: Response) => void = () => {};
    let created = false;
    let createdName = "matrix-pending";
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method === "POST") {
        if (typeof init.body === "string") {
          createdName = (JSON.parse(init.body) as { name?: string }).name ?? createdName;
        }
        if (createdName === "main") {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
        }
        return new Promise<Response>((resolve) => {
          resolveCreate = (response) => {
            created = true;
            resolve(response);
          };
        });
      }
      if (url.endsWith("/api/terminal/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", tabs: [] },
              ...(created ? [{ name: createdName, status: "active", placement: "active", tabs: [] }] : []),
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openNewSessionMenu();
    const newSessionButton = screen.getByRole("button", { name: "New session" });
    const menu = screen.getByRole("menu", { name: "New session menu" });

    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /^Shell(?:\s+⌘T)?$/i }));
      await Promise.resolve();
    });

    expect(newSessionButton).toHaveProperty("disabled", true);
    expect(screen.getByTestId("terminal-session-pending-row").textContent).toContain("Creating session");

    await act(async () => {
      resolveCreate({ ok: true, json: async () => ({ name: "matrix-pending" }) } as Response);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("terminal-session-pending-row")).toBeNull();
    expect(screen.getByTestId(`terminal-session-card-${createdName}`)).toBeTruthy();
  });

  it("opens the left terminal panel on Shells first", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByLabelText("Search sessions")).toBeTruthy();
  });

  it("keeps row actions compact and moves placement into the overflow menu", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    revealSessionActions("main");
    const actions = screen.getByTestId("terminal-session-actions-main");
    expect(within(actions).getByRole("button", { name: "Rename matrix-main" })).toBeTruthy();
    const moreButton = within(actions).getByRole("button", { name: "More actions for matrix-main" });
    expect(moreButton.style.width).toBe("24px");
    expect(moreButton.style.height).toBe("24px");
    expect(screen.queryByRole("button", { name: "Move to Background" })).toBeNull();
    const menu = await openSessionContextMenu("main");
    expect(menu.style.minWidth).toBe("152px");
    expect(menu.style.padding).toBe("5px");
    const moveItem = within(menu).getByRole("menuitem", { name: "Move to Background" });
    const copyItem = within(menu).getByRole("menuitem", { name: "Copy Command" });
    const closeItem = within(menu).getByRole("menuitem", { name: "Close" });
    expect(moveItem.style.height).toBe("28px");
    expect(document.activeElement).toBe(moveItem);
    fireEvent.keyDown(moveItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(copyItem);
    fireEvent.keyDown(copyItem, { key: "End" });
    expect(document.activeElement).toBe(closeItem);
    fireEvent.keyDown(closeItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(moveItem);
    fireEvent.keyDown(moveItem, { key: "ArrowUp" });
    expect(document.activeElement).toBe(closeItem);
    fireEvent.keyDown(closeItem, { key: "Home" });
    expect(document.activeElement).toBe(moveItem);
    fireEvent.keyDown(moveItem, { key: "Tab" });
    expect(screen.queryByRole("menu", { name: "Actions for matrix-main" })).toBeNull();
    expect(document.activeElement).toBe(moreButton);
    expect(screen.queryByRole("menuitem", { name: "Move matrix-main to background" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Copy connect command for matrix-main" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Close matrix-main" })).toBeNull();
  });

  it("lets desktop users resize the terminal sessions drawer", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(sidebarShell.style.width).toBe("392px");

    const resizeHandle = screen.getByRole("button", { name: "Resize sessions drawer" });
    const setPointerCapture = vi.fn();
    Object.defineProperty(resizeHandle, "setPointerCapture", { configurable: true, value: setPointerCapture });
    await act(async () => {
      fireEvent.pointerDown(resizeHandle, { clientX: 392, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 456 });
      fireEvent.pointerUp(window);
      await Promise.resolve();
    });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(sidebarShell.style.width).toBe("456px");

    await act(async () => {
      fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });
      await Promise.resolve();
    });

    expect(sidebarShell.style.width).toBe("440px");
  });

  it("uses the terminal app drawer border for the sessions drawer divider", async () => {
    terminalSettingsState.themeId = "dark";
    terminalSettingsState.appThemeId = "matrix-dark";

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    const resizeHandle = screen.getByRole("button", { name: "Resize sessions drawer" });

    expect(sidebarShell.style.borderRight).toBe("1px solid var(--terminal-drawer-border)");
    expect(resizeHandle.style.background).toBe("var(--terminal-drawer-resize-handle-bg)");
    expect(resizeHandle.getAttribute("style")).toContain("--terminal-drawer-resize-handle-bg");
    expect(resizeHandle.getAttribute("style")).not.toContain("--muted-foreground");
    expect(resizeHandle.style.background).not.toContain("transparent");
    expect(resizeHandle.style.background).not.toContain("197, 196, 180");

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    expect(screen.getByTestId("terminal-collapsed-rail").style.borderRight).toBe("1px solid var(--terminal-drawer-border)");
  });

  it("stops terminal drawer resizing when the drag is canceled", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    const resizeHandle = screen.getByRole("button", { name: "Resize sessions drawer" });
    await act(async () => {
      fireEvent.pointerDown(resizeHandle, { clientX: 392, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 456 });
      fireEvent.pointerCancel(window);
      fireEvent.pointerMove(window, { clientX: 520 });
      await Promise.resolve();
    });

    expect(sidebarShell.style.width).toBe("456px");
  });

  it("does not treat drawer controls as title-bar zooms after desktop top chrome removal", async () => {
    const handleTitleDoubleClick = vi.fn();
    render(<TerminalApp windowControls={{ dragHandleProps: { onDoubleClick: handleTitleDoubleClick } }} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Toggle Terminal fullscreen" })).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Theme" }));

    expect(handleTitleDoubleClick).not.toHaveBeenCalled();
  });

  it("highlights the shell attached to the active restored pane on first render", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [
              {
                id: "tab-docs",
                label: "Docs",
                paneTree: { type: "pane", id: "pane-docs", cwd: "projects", sessionId: "docs" },
              },
            ],
            activeTabId: "tab-docs",
            sidebarOpen: true,
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", tabs: [] },
              { name: "docs", status: "active", placement: "active", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("false");
  });

  it("attaches and highlights the first ordered shell when no saved layout exists", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "bench", status: "active", placement: "active", tabs: [] },
              { name: "main", status: "active", placement: "active", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: "bench",
      },
    });
    expect(screen.getByTestId("terminal-session-row-bench").getAttribute("data-selected")).toBe("true");
  });

  it("renders the Paper collapsed sessions rail in layout flow when hidden", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-drawer-collapse-icon").querySelector('path[d="m11 17-5-5 5-5"]')).toBeTruthy();
    expect(screen.getByTestId("terminal-sidebar-shell").style.transition).toContain("transform");

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(sidebarShell.style.transition).toContain("transform");
    expect(sidebarShell.style.opacity).toBe("1");
    const rail = screen.getByTestId("terminal-collapsed-rail");
    expect(rail.style.width).toBe("76px");
    expect(rail.className).not.toContain("absolute");
    expect(screen.getByRole("button", { name: "Expand sessions drawer" })).toBeTruthy();
    expect(screen.getByTestId("terminal-drawer-expand-icon").querySelector('path[d="m6 17 5-5-5-5"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    const matrixRailButton = screen.getByRole("button", { name: "Open matrix-main" });
    expect(matrixRailButton.textContent).toBe("mma");
    expect(matrixRailButton.getAttribute("aria-current")).toBe("true");
    expect(matrixRailButton.getAttribute("data-selected")).toBe("true");
  });

  it("uses Paper collapsed rail abbreviations and fixed control sizing", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", visualStatus: "running", tabs: [] },
              { name: "claude-review", status: "active", placement: "active", visualStatus: "finished", tabs: [] },
              { name: "codex-backend", status: "active", placement: "active", visualStatus: "waiting", tabs: [] },
              { name: "deploy-logs", status: "active", placement: "background", visualStatus: "running", tabs: [] },
              { name: "hotfix-auth", status: "active", placement: "background", visualStatus: "idle", tabs: [] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const fixedControls = [
      screen.getByTestId("terminal-collapsed-brand"),
      screen.getByRole("button", { name: "Expand sessions drawer" }),
      screen.getByRole("button", { name: "New session" }),
      screen.getByRole("button", { name: "Open matrix-main" }),
      screen.getByRole("button", { name: "Open claude-review" }),
    ];
    for (const control of fixedControls) {
      expect(control.style.width).toBe("40px");
      expect(control.style.height).toBe("40px");
      expect(control.style.flexShrink).toBe("0");
    }
    const matrixRailButton = screen.getByRole("button", { name: "Open matrix-main" });
    const matrixRailDot = screen.getByTestId("terminal-session-status-main");
    expect(matrixRailButton.style.overflow).toBe("visible");
    expect(matrixRailDot.style.top).toBe("-3px");
    expect(matrixRailDot.style.right).toBe("-3px");
    expect(matrixRailDot.style.borderTopWidth).toBe("2px");
    expect(matrixRailDot.getAttribute("style")).toContain("border-color: var(--terminal-drawer-bg)");
    expect(matrixRailDot.style.zIndex).toBe("1");
    const newSessionIcon = screen.getByTestId("terminal-collapsed-new-session-icon");
    expect(newSessionIcon.getAttribute("width")).toBe("18");
    expect(newSessionIcon.getAttribute("height")).toBe("18");

    expect(screen.getByRole("button", { name: "Open matrix-main" }).textContent).toBe("mma");
    expect(screen.getByRole("button", { name: "Open claude-review" }).textContent).toBe("cre");
    expect(screen.getByRole("button", { name: "Open codex-backend" }).textContent).toBe("cba");
    expect(screen.getByRole("button", { name: "Open deploy-logs" }).textContent).toBe("dlo");
    expect(screen.getByRole("button", { name: "Open hotfix-auth" }).textContent).toBe("hau");
    expect(screen.getByTestId("terminal-collapsed-background-divider").style.marginTop).toBe("2px");
    expect(screen.getByTestId("terminal-collapsed-background-divider").style.width).toBe("36px");
    expect(screen.getByRole("button", { name: "Open deploy-logs" }).style.opacity).toBe("0.72");
  });

  it("keeps collapsed rail sessions visible after hiding a filtered drawer", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "no-matches" } });
    });

    expect(screen.getByText("No sessions match")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));
    });

    expect(screen.getByTestId("terminal-collapsed-rail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
  });

  it("opens Matrix-named shell sessions from Ctrl+Shift+T", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("application", { name: "Terminal" }), {
        key: "T",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(CANONICAL_SESSION_NAME_PATTERN),
      },
    });
  });

  it("copies a local CLI attach command when clicking a shell session name", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
        json: async () => ({ sessions: [{ name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [] }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await openSessionContextMenu("main");

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Command" }));
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not persist the mobile-forced sidebar state into shared terminal layout", async () => {
    render(<TerminalApp mobile initialSessionId="main" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    const layoutSave = vi.mocked(global.fetch).mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));
    expect(layoutSave).toBeUndefined();
  });

  it("starts normal terminal tabs on the canonical main shell session", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "main",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "main", cwd: "projects" }),
      }),
    );
  });

  it("replaces saved legacy pty layouts with the canonical main shell session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "legacy-tab",
              label: "projects",
              paneTree: {
                type: "pane",
                id: "legacy-pane",
                cwd: "projects",
                sessionId: "550e8400-e29b-41d4-a716-446655440000",
              },
            }],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("main");
  });

  it("replaces mixed canonical and legacy pty layouts with the canonical main shell session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [
              {
                id: "main-tab",
                label: "main",
                paneTree: {
                  type: "pane",
                  id: "main-pane",
                  cwd: "projects",
                  sessionId: "main",
                },
              },
              {
                id: "legacy-tab",
                label: "Legacy Zellij",
                paneTree: {
                  type: "pane",
                  id: "legacy-pane",
                  cwd: "projects",
                  sessionId: "550e8400-e29b-41d4-a716-446655440000",
                },
              },
            ],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Legacy Zellij")).toBeNull();
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("main");
  });

  it("recreates saved canonical shell sessions before restoring a layout", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "bench-tab",
              label: "bench",
              paneTree: {
                type: "pane",
                id: "bench-pane",
                cwd: "projects",
                sessionId: "bench",
              },
            }],
            activeTabId: "bench-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "bench", cwd: "projects" }),
      }),
    );
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("bench");
  });

  it("does not replace a legacy layout after unmount while ensuring the canonical session", async () => {
    let resolveSessions: ((value: { ok: boolean; json: () => Promise<{ sessions: Array<{ name: string }> }> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "legacy-tab",
              label: "projects",
              paneTree: {
                type: "pane",
                id: "legacy-pane",
                cwd: "projects",
                sessionId: "550e8400-e29b-41d4-a716-446655440000",
              },
            }],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return new Promise((resolve) => {
          resolveSessions = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    const { unmount } = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeUnmount = paneGridSpy.mock.calls.length;

    unmount();
    await act(async () => {
      resolveSessions?.({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it("persists attached session ids in the saved layout", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy).toHaveBeenCalled();

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    expect(props.paneTree.type).toBe("pane");

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-123");
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-123",
          },
        },
      ],
    });
  });

  it("flushes attached session ids on pagehide before the debounce fires", async () => {
    render(<TerminalApp />);

    // Flush microtasks so async initLayout completes and setInitialized(true) propagates
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-refresh");
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-refresh",
          },
        },
      ],
    });
  });

  it("creates toolbar shell launches as Matrix-named canonical shell sessions", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/sessions") &&
      init?.method === "POST" &&
      typeof init.body === "string" &&
      CANONICAL_SESSION_NAME_PATTERN.test(JSON.parse(init.body).name)
    ));
    expect(createCall).toBeTruthy();
    const body = JSON.parse(createCall?.[1]?.body as string) as { name: string; cwd: string };
    expect(body).toMatchObject({ cwd: "projects" });
    expect(body.name).toMatch(CANONICAL_SESSION_NAME_PATTERN);

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string; startupCommand?: string };
    };
    expect(props.paneTree.sessionId).toBe(body.name);
    expect(props.paneTree.startupCommand).toBeUndefined();
  });

  it("cleans up a just-created Matrix shell when unmounted before the tab is attached", async () => {
    let resolveCreate: ((value: { ok: boolean; status: number; json: () => Promise<{ name: string }> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method !== "POST" && init?.method !== "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      if (url.includes("/api/terminal/sessions/") && init?.method === "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const { unmount } = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/sessions") &&
      init?.method === "POST"
    ));
    expect(createCall).toBeTruthy();
    const name = JSON.parse(createCall?.[1]?.body as string).name as string;

    unmount();
    await act(async () => {
      resolveCreate?.({ ok: true, status: 200, json: async () => ({ name }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/terminal/sessions/${name}?force=1`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("manages canonical Matrix shells from a dedicated sidebar surface", async () => {
    let mainDeleted = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/main") && init?.method === "DELETE") {
        mainDeleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ name: "matrix-new", created: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              ...(mainDeleted ? [] : [{
                name: "main",
                status: "active",
                attachedClients: 1,
                tabs: [{ idx: 0, name: "dev", focused: true }],
              }]),
              {
              name: "bench",
              status: "degraded",
              attachedClients: 0,
              tabs: [{ idx: 0, name: "latency", focused: true }, { idx: 3, name: "load" }],
            }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Search sessions")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.getByText("bench")).toBeTruthy();
    const mainCard = screen.getByTestId("terminal-session-card-main");
    revealSessionActions("main");
    const mainActions = screen.getByTestId("terminal-session-actions-main");
    expect(within(mainActions).getByRole("button", { name: "Rename matrix-main" })).toBeTruthy();
    expect(within(mainActions).getByRole("button", { name: "More actions for matrix-main" }).closest(".group")).toBe(mainCard);
    expect(screen.queryByRole("button", { name: "Move to Background" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open bench/i }));
    });
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "bench" },
    });

    await act(async () => {
      await openNewSessionMenu();
      const menu = screen.getByRole("menu", { name: "New session menu" });
      const shellItem = within(menu).getByRole("menuitem", { name: /Shell/ });
      fireEvent.click(shellItem);
      fireEvent.click(shellItem);
      await Promise.resolve();
      await Promise.resolve();
    });
    const createCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions") && init?.method === "POST"
    ));
    expect(createCalls).toHaveLength(1);

    const closeMenu = await openSessionContextMenu("main");

    await act(async () => {
      const deleteButton = within(closeMenu).getByRole("menuitem", { name: "Close" });
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
      await Promise.resolve();
    });
    expect(vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE"
    ))).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const deleteCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE"
    ));
    expect(deleteCalls).toHaveLength(1);
    expect(screen.queryByText("matrix-main")).toBeNull();
  });

  it("removes open panes for a managed shell after deleting that shell", async () => {
    let benchDeleted = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/bench") && init?.method === "DELETE") {
        benchDeleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              {
                name: "main",
                status: "active",
                attachedClients: 0,
                tabs: [{ idx: 0, name: "main", focused: true }],
              },
              ...(benchDeleted ? [] : [{
                name: "bench",
                status: "active",
                attachedClients: 0,
                tabs: [{ idx: 0, name: "work", focused: true }],
              }]),
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open bench/i }));
      await Promise.resolve();
    });
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "bench" },
    });

    const benchMenu = await openSessionContextMenu("bench", "bench");

    await act(async () => {
      fireEvent.click(within(benchMenu).getByRole("menuitem", { name: "Close" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/bench?force=1") && init?.method === "DELETE"
    ))).toHaveLength(1);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: expect.not.objectContaining({ sessionId: "bench" }),
    });
  });

  it("keeps the Shells sidebar synchronized after manual refresh", async () => {
    let revealBench = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: revealBench
              ? [{ name: "main", status: "active" }, { name: "bench", status: "active" }]
              : [{ name: "main", status: "active" }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    expect(screen.queryByText("bench")).toBeNull();

    await act(async () => {
      revealBench = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
  });

  it("keeps the last known Shells list visible during transient refresh failures", async () => {
    let shellListMode: "initial" | "fail" | "recover" = "initial";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        if (shellListMode === "fail") {
          shellListMode = "recover";
          return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: shellListMode === "recover"
              ? [{ name: "main", status: "active" }, { name: "bench", status: "active" }]
              : [{ name: "main", status: "active" }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    shellListMode = "fail";

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    expect(screen.getByText("Failed to load shells")).toBeTruthy();
    expect(screen.getByTestId("terminal-sessions-stale-label").textContent).toContain("Terminal session data is stale");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
    expect(screen.queryByText("Failed to load shells")).toBeNull();
    expect(screen.queryByTestId("terminal-sessions-stale-label")).toBeNull();
  });

  it("refreshes the Shells sidebar while open so exited zellij sessions disappear", async () => {
    let shellList = [{ name: "main", status: "active" }];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    const shellListCallsBeforeWait = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    )).length;

    await act(async () => {
      shellList = [];
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const shellListCallsAfterWait = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    )).length;
    expect(shellListCallsAfterWait).toBeGreaterThan(shellListCallsBeforeWait);
    expect(screen.queryByRole("button", { name: "Copy Command" })).toBeNull();
  });

  it("does not clobber a concurrent Shells refresh when delete rollback runs", async () => {
    let shellList = [{ name: "main", status: "active" }];
    let resolveDelete: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
    const deletePromise = new Promise<{ ok: boolean; status: number; json: () => Promise<object> }>((resolve) => {
      resolveDelete = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE") {
        return deletePromise;
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();

    const menu = await openSessionContextMenu("main");

    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Close" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("dialog", { name: "Close this session?" })).toBeTruthy();
    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Copy Command" })).toBeNull();

    await act(async () => {
      shellList = [{ name: "bench", status: "active" }];
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("bench")).toBeTruthy();

    await act(async () => {
      resolveDelete?.({ ok: false, status: 503, json: async () => ({ ok: false }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
    expect(screen.getByTestId("terminal-session-card-main")).toBeTruthy();
    expect(screen.getByText("Failed to remove shell")).toBeTruthy();
  });

  it("surfaces shell creation failures in the Shells sidebar", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main", status: "active" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    expect(screen.getByText("Failed to create shell")).toBeTruthy();
  });

  it("renders agent install state in the new-session menu without ready badges", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: true, authState: "ok" },
              { id: "codex", installed: true, authState: "ok" },
              { id: "opencode", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "pi", installed: false, authState: "unknown", errorCode: "agent_missing" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await openNewSessionMenu();
    });

    const menu = screen.getByRole("menu", { name: "New session menu" });
    expect(within(menu).getByRole("menuitem", { name: /Shell/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Claude Code/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Codex/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /OpenCode.*Install/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Pi.*Install/ })).toBeTruthy();
    expect(within(menu).queryByText("Ready")).toBeNull();
    expect(within(menu).getAllByText("Install")).toHaveLength(2);
    const installPill = within(menu).getAllByTestId("terminal-agent-install-pill")[0];
    expect(installPill.style.background).toBe("var(--terminal-drawer-action-bg)");
    expect(installPill.style.color).toBe("var(--terminal-drawer-action-fg)");
    expect(within(menu).getByTestId("terminal-agent-logo-claude")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-codex")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-opencode")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-pi")).toBeTruthy();
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-claude"), "/agent-logos/claude-code.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-codex"), "/agent-logos/codex.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-opencode"), "/agent-logos/opencode-white.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-pi"), "/agent-logos/pi-coding-agent.png");
  });

  it("refreshes agent install state when opening the new-session menu", async () => {
    let agentStatusCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        agentStatusCalls += 1;
        const installed = agentStatusCalls > 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: true, authState: "ok" },
              { id: "codex", installed: true, authState: "ok" },
              { id: "opencode", installed, authState: installed ? "ok" : "unknown", errorCode: installed ? null : "agent_missing" },
              { id: "pi", installed, authState: installed ? "ok" : "unknown", errorCode: installed ? null : "agent_missing" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await openNewSessionMenu();
    });

    const menu = screen.getByRole("menu", { name: "New session menu" });
    await vi.waitFor(() => {
      expect(within(menu).queryByRole("menuitem", { name: /OpenCode.*Install/ })).toBeNull();
      expect(within(menu).queryByRole("menuitem", { name: /Pi.*Install/ })).toBeNull();
    });
    expect(within(menu).getByRole("menuitem", { name: /^OpenCode$/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /^Pi$/ })).toBeTruthy();
  });

  it("starts installed agents directly from the new-session menu", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: true, authState: "ok" },
              { id: "codex", installed: true, authState: "ok" },
              { id: "opencode", installed: true, authState: "ok" },
              { id: "pi", installed: true, authState: "ok" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string };
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: body.name, created: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Claude Code/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"claude-[a-z0-9-]+".*"cmd":"claude"/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^claude-[a-z0-9-]+$/),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Codex/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"codex-[a-z0-9-]+".*"cmd":"codex"/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^codex-[a-z0-9-]+$/),
        compatMode: "codex-tui",
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/^OpenCode$/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"opencode-[a-z0-9-]+".*"cmd":"opencode"/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^opencode-[a-z0-9-]+$/),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/^Pi$/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"pi-[a-z0-9-]+".*"cmd":"pi"/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^pi-[a-z0-9-]+$/),
      },
    });
  });

  it("retries agent session creation from home when the selected cwd is missing", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: true, authState: "ok" },
              { id: "codex", installed: true, authState: "ok" },
              { id: "opencode", installed: true, authState: "ok" },
              { id: "pi", installed: true, authState: "ok" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string; cwd?: string };
        if (body.name?.startsWith("claude-") && body.cwd === "projects") {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({ error: { code: "invalid_cwd", message: "Invalid cwd" } }),
            clone() {
              return this;
            },
          } as Response);
        }
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: body.name, created: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main", status: "active" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Claude Code/);
    });

    const claudeBodies = terminalSessionPostBodies()
      .map((body) => JSON.parse(body) as { name: string; cwd: string; cmd?: string })
      .filter((body) => body.name.startsWith("claude-"));

    expect(claudeBodies.map((body) => body.cwd)).toEqual(["projects", "~"]);
    expect(claudeBodies.every((body) => body.cmd === "claude")).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        cwd: "~",
        sessionId: expect.stringMatching(/^claude-[a-z0-9-]+$/),
      },
    });
  });

  it("opens a new shell tab that runs the installer when an agent is missing", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "codex", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "opencode", installed: false, authState: "unknown", errorCode: "agent_missing" },
              { id: "pi", installed: false, authState: "unknown", errorCode: "agent_missing" },
            ],
          }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string };
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: body.name, created: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Claude Code.*Install/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"claude-[a-z0-9-]+".*"cmd":"sh -lc .*export MATRIX_NODE_PREFIX=/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^claude-[a-z0-9-]+$/),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Codex.*Install/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"codex-[a-z0-9-]+".*"cmd":"sh -lc .*export MATRIX_NODE_PREFIX=/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^codex-[a-z0-9-]+$/),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/OpenCode.*Install/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"opencode-[a-z0-9-]+".*"cmd":"sh -lc .*export MATRIX_NODE_PREFIX=/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^opencode-[a-z0-9-]+$/),
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Pi.*Install/);
    });

    expect(terminalSessionPostBodies().some((body) => /"name":"pi-[a-z0-9-]+".*"cmd":"sh -lc .*export MATRIX_NODE_PREFIX=.*--ignore-scripts/.test(body))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^pi-[a-z0-9-]+$/),
      },
    });
  });
});
