// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const CANONICAL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TWO_WORD_SESSION_NAME_PATTERN = /^[a-z]+-[a-z]+$/;

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
import {
  doesCompactGitContextFit,
  ShellSessionGroup,
} from "../../shell/src/components/terminal/TerminalSidebarItems.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";
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
  fireEvent.click(screen.getByRole("button", { name: "Choose session type" }));
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
  const item = await vi.waitFor(() => (
    within(screen.getByRole("menu", { name: "New session menu" })).getByRole("menuitem", { name })
  ));
  await act(async () => {
    fireEvent.click(item);
    await Promise.resolve();
  });
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

function terminalSessionPostPayloads(): Array<{ name?: unknown; cmd?: unknown; cwd?: unknown; agent?: unknown }> {
  return terminalSessionPostBodies().map((body) => JSON.parse(body) as { name?: unknown; cmd?: unknown; cwd?: unknown; agent?: unknown });
}

function expectTerminalCreatePayloadForCommand(cmd: string | RegExp): { name: string; cmd: string; cwd?: unknown; agent?: unknown } {
  const payload = terminalSessionPostPayloads().find((body) => (
    typeof body.name === "string" &&
    typeof body.cmd === "string" &&
    (typeof cmd === "string" ? body.cmd === cmd : cmd.test(body.cmd))
  ));
  expect(payload).toBeTruthy();
  expect(payload?.name).toMatch(TWO_WORD_SESSION_NAME_PATTERN);
  expect(String(payload?.name).split("-")).toHaveLength(2);
  return payload as { name: string; cmd: string; cwd?: unknown; agent?: unknown };
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

function completeAgentStatusResponse(installState: "installed" | "missing" | "unknown" = "unknown") {
  return {
    agents: (["claude", "codex", "opencode", "pi"] as const).map((id) => ({
      id,
      installState,
      installed: installState === "installed" ? true : installState === "missing" ? false : null,
    })),
  };
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
      if (url.includes("/api/agents")) {
        return Promise.resolve({ ok: true, json: async () => completeAgentStatusResponse() });
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
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main", status: "active" }] }) });
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

  it("renders agent session metadata with an unobscured right-side hover card", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(hover: hover) and (pointer: fine)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
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
          json: async () => ({ sessions: [
            {
              name: "calm-otter",
              status: "degraded",
              placement: "active",
              agent: "codex",
              subtitle: "Implement agent-aware terminal sessions",
              lastAction: "Requested approval",
              agentUpdatedAt: "2026-07-18T10:00:00.000Z",
              model: "gpt-5.4",
              strength: "high",
              project: "Matrix OS",
              repository: "HamedMP/matrix-os",
              branch: "codex/session-context",
              pullRequest: { number: 1032, url: "https://github.com/HamedMP/matrix-os/pull/1032" },
              tabs: [],
            },
            { name: "main", status: "active", placement: "active", tabs: [] },
          ] }),
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

    const agentCard = screen.getByTestId("terminal-session-card-calm-otter");
    Object.defineProperty(agentCard, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 20, right: 300, top: 20, bottom: 98, width: 280, height: 78, x: 20, y: 20, toJSON: () => ({}) }),
    });
    expect(agentCard.style.height).toBe("78px");
    const sessionName = screen.getByTestId("terminal-session-name-calm-otter");
    expect(sessionName.style.fontFamily).toBe('var(--font-geist-mono), "Geist Mono", ui-monospace, monospace');
    const sessionSubtitle = screen.getByTestId("terminal-session-subtitle-calm-otter");
    expect(sessionSubtitle.textContent).toBe(
      "Implement agent-aware terminal sessions",
    );
    expect(sessionSubtitle.style.fontFamily).toBe("var(--font-geist-sans), Geist, system-ui, sans-serif");
    const agentState = screen.getByTestId("terminal-session-agent-state-calm-otter");
    expect(agentState.style.fontFamily).toBe("var(--font-geist-sans), Geist, system-ui, sans-serif");
    expect(agentState.textContent).toContain("Codex");
    expect(agentState.textContent).toContain("waiting");
    expect(agentState.textContent).toContain("gpt-5.4");
    expect(agentState.textContent).toContain("High");
    const compactGitContext = within(agentState).getByTestId("terminal-session-compact-git-calm-otter");
    expect(compactGitContext.textContent).toBe("HamedMP/matrix-os · PR #1032");
    expect(compactGitContext.style.position).toBe("absolute");
    expectOptimizedImageSrc(
      within(agentState).getByTestId("terminal-session-agent-logo-image-codex"),
      "/agent-logos/codex.png",
    );
    const compactAgentLogo = within(agentState).getByTestId("terminal-session-agent-logo-codex");
    expect(compactAgentLogo.style.border).toBe("");
    expect(compactAgentLogo.style.boxShadow).toBe("");
    expect(screen.queryByTestId("terminal-session-subtitle-main")).toBeNull();
    expect(within(screen.getByTestId("terminal-session-card-main")).queryByTestId(/terminal-session-agent-logo-/)).toBeNull();
    expect(screen.getByTestId("terminal-session-card-main").style.height).toBe("52px");

    revealSessionActions("calm-otter");
    const nameRow = screen.getByTestId("terminal-session-name-row-calm-otter");
    expect(within(nameRow).getByRole("button", { name: "Rename calm-otter" })).toBeTruthy();
    expect(screen.getByTestId("terminal-session-actions-calm-otter").style.right).toBe("8px");

    fireEvent.mouseEnter(agentCard);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const hoverCard = screen.getByTestId("terminal-session-hover-card-calm-otter");
    expect(hoverCard.getAttribute("data-side")).toBe("right");
    expect(hoverCard.style.background).not.toContain("var(");
    expect(hoverCard.style.background).not.toBe("");
    expect(hoverCard.style.color).not.toContain("var(");
    expect(hoverCard.textContent).toContain("waiting");
    expect(hoverCard.textContent).toContain("Requested approval");
    expect(hoverCard.textContent).toContain("Model");
    expect(hoverCard.textContent).toContain("gpt-5.4");
    expect(hoverCard.textContent).toContain("Strength");
    expect(hoverCard.textContent).toContain("High");
    expect(hoverCard.textContent).toContain("Project");
    expect(hoverCard.textContent).toContain("Matrix OS");
    expect(hoverCard.textContent).toContain("Repository");
    expect(hoverCard.textContent).toContain("HamedMP/matrix-os");
    expect(within(hoverCard).getByText("HamedMP/matrix-os").style.fontFamily).toBe(
      'var(--font-geist-mono), "Geist Mono", ui-monospace, monospace',
    );
    expect(hoverCard.textContent).toContain("Branch");
    expect(hoverCard.textContent).toContain("codex/session-context");
    expect(hoverCard.textContent).toContain("Pull request");
    expect(within(hoverCard).getByRole("link", { name: "PR #1032" }).getAttribute("href")).toBe(
      "https://github.com/HamedMP/matrix-os/pull/1032",
    );
    expectOptimizedImageSrc(
      within(hoverCard).getByTestId("terminal-session-hover-agent-logo-image-codex"),
      "/agent-logos/codex.png",
    );
    expect(
      within(hoverCard).getByTestId("terminal-session-hover-agent-logo-image-codex").getAttribute("loading"),
    ).toBe("eager");
    const hoverAgentLogo = within(hoverCard).getByTestId("terminal-session-hover-agent-logo-codex");
    expect(hoverAgentLogo.style.border).toBe("");
    expect(hoverAgentLogo.style.boxShadow).toBe("");

    const moreButton = screen.getByRole("button", { name: "More actions for calm-otter" });
    fireEvent.pointerEnter(moreButton, { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.queryByTestId("terminal-session-hover-card-calm-otter")).toBeNull();

    const menu = await openSessionContextMenu("calm-otter", "calm-otter");
    expect(within(menu).getByRole("menuitem", { name: "Copy Connect Command" })).toBeTruthy();
    expect(screen.queryByTestId("terminal-session-hover-card-calm-otter")).toBeNull();

    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Move to Background" }), { key: "Escape" });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 560 });
    fireEvent.pointerLeave(agentCard, { pointerType: "mouse" });
    fireEvent.pointerEnter(agentCard, { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.queryByTestId("terminal-session-hover-card-calm-otter")).toBeNull();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    fireEvent.pointerLeave(agentCard, { pointerType: "mouse" });
    const plainCard = screen.getByTestId("terminal-session-card-main");
    Object.defineProperty(plainCard, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 20, right: 300, top: 110, bottom: 162, width: 280, height: 52, x: 20, y: 110, toJSON: () => ({}) }),
    });
    fireEvent.pointerEnter(plainCard, { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const plainHoverCard = screen.getByTestId("terminal-session-hover-card-main");
    expect(plainHoverCard.textContent).toContain("Terminal");
    expect(plainHoverCard.textContent).toContain("active");
  });

  it("compacts empty agent subtitles and expands when refreshed metadata adds one", () => {
    const shell = {
      name: "codex-fix",
      status: "active",
      placement: "active",
      visualStatus: "running",
      agent: "codex",
      subtitle: "   ",
      tabs: [],
    } satisfies ShellSessionSummary;
    const groupProps = {
      label: "Active" as const,
      deletingShellNames: [],
      foreground: true,
      selectedShellName: null,
      onOpen: vi.fn(),
      onToggle: vi.fn(),
      onRename: vi.fn(async () => true),
      onDelete: vi.fn(),
      draggingShellName: null,
      dragOverShellName: null,
      onDragStart: vi.fn(),
      onDragOver: vi.fn(),
      onDrop: vi.fn(),
      onDragEnd: vi.fn(),
    };
    const { rerender } = render(<ShellSessionGroup {...groupProps} shells={[shell]} />);

    expect(screen.getByTestId("terminal-session-card-codex-fix").style.height).toBe("60px");

    const compactName = screen.getByTestId("terminal-session-name-codex-fix");
    const compactMetadata = screen.getByTestId("terminal-session-agent-state-codex-fix");
    expect(compactName.textContent).toBe("codex-fix");
    expect(compactMetadata.textContent).toContain("Codex");
    expect(compactMetadata.textContent).toContain("running");
    expect(screen.queryByTestId("terminal-session-subtitle-codex-fix")).toBeNull();
    expect(screen.getByTestId("terminal-session-name-row-codex-fix").parentElement?.style.gridTemplateRows).toBe(
      "18px 16px",
    );

    rerender(
      <ShellSessionGroup
        {...groupProps}
        shells={[{ ...shell, subtitle: "Fix Terminal sessions" }]}
      />,
    );
    expect(screen.getByTestId("terminal-session-subtitle-codex-fix").textContent).toBe("Fix Terminal sessions");
    expect(screen.getByTestId("terminal-session-card-codex-fix").style.height).toBe("78px");
    expect(screen.getByTestId("terminal-session-name-row-codex-fix").parentElement?.style.gridTemplateRows).toBe(
      "18px 16px 16px",
    );

    rerender(<ShellSessionGroup {...groupProps} shells={[shell]} />);
    expect(screen.queryByTestId("terminal-session-subtitle-codex-fix")).toBeNull();
    expect(screen.getByTestId("terminal-session-card-codex-fix").style.height).toBe("60px");
    expect(screen.getByTestId("terminal-session-name-row-codex-fix").parentElement?.style.gridTemplateRows).toBe(
      "18px 16px",
    );
  });

  it("shows compact Git context only when it fits on the existing metadata line", () => {
    expect(doesCompactGitContextFit({ availableWidth: 360, primaryWidth: 190, contextWidth: 130 })).toBe(true);
    expect(doesCompactGitContextFit({ availableWidth: 280, primaryWidth: 190, contextWidth: 130 })).toBe(false);
    expect(doesCompactGitContextFit({ availableWidth: 0, primaryWidth: 0, contextWidth: 0 })).toBe(false);
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
    expect(screen.getByRole("application", { name: "Terminal" }).style.fontFamily).toBe(
      "var(--font-geist-sans), Geist, system-ui, sans-serif",
    );
    const wordmark = screen.getByTestId("terminal-expanded-wordmark");
    expect(wordmark.textContent).toBe("Matrix OS");
    expect(wordmark.style.color).toBe("var(--terminal-drawer-fg)");
    expect(wordmark.style.fontFamily).toBe("var(--font-orbitron), Orbitron, sans-serif");
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

  it("uses a theme-aware foreground for the Terminal wordmark", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-expanded-wordmark").style.color).toBe("var(--terminal-drawer-fg)");
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

    const appThemePanel = screen.getByTestId("terminal-app-theme-panel");
    expect(appThemePanel).toBe(screen.getByRole("menu", { name: "Theme" }));
    expect(appThemePanel.dataset.terminalThemeMotion).toBe("open");
    expect(appThemePanel.style.animation).toContain("terminalThemePanelOpen");
    expect(appThemePanel.style.bottom).toBe("100%");
    expect(appThemePanel.style.left).toBe("0px");
    expect(appThemePanel.style.top).toBe("auto");
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
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-card-selected-bg")).toBe("#30372B");

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
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-card-selected-bg")).toBe("#FFFFFF");
    expect(screen.getByTestId("terminal-sidebar-shell").style.background).toBe("var(--terminal-drawer-bg)");
    expect(screen.getByTestId("terminal-session-card-main").style.background).toBe("var(--terminal-drawer-card-selected-bg)");
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
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-card-selected-bg")).toBe("#1C3021");
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
    expect(shellThemePanel.dataset.terminalThemeMotion).toBe("forward");
    expect(shellThemePanel.style.animation).toContain("terminalThemePanelForward");
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

    const returnedAppThemePanel = screen.getByTestId("terminal-app-theme-panel");
    expect(returnedAppThemePanel).toBe(screen.getByRole("menu", { name: "Theme" }));
    expect(returnedAppThemePanel.dataset.terminalThemeMotion).toBe("back");
    expect(returnedAppThemePanel.style.animation).toContain("terminalThemePanelBack");
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
    expect(screen.queryByRole("button", { name: "Copy Connect Command" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Matrix shell connect command for matrix-main" })).toBeNull();
    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    const actions = screen.getByTestId("terminal-session-actions-main");
    expect(row!.style.display).toBe("grid");
    expect(row!.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(actions.style.position).toBe("absolute");
    expect(actions.style.right).toBe("8px");
    expect(actions.style.top).toBe("50%");
    expect(actions.style.transform).toBe("translateY(-50%)");
    expect(screen.queryByText("matrix shell connect")).toBeNull();
    expect(actions.style.maxHeight).toBe("");
    expect(screen.getByTestId("terminal-session-name-row-main").querySelector('[aria-label="Rename matrix-main"]')).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "More actions for matrix-main" })).toBeTruthy();
    expect(within(actions).queryByRole("button", { name: "Copy Connect Command" })).toBeNull();
    expect(within(actions).queryByRole("button", { name: "Close" })).toBeNull();

    let menu = await openSessionContextMenu("main");
    const moveButton = within(menu).getByRole("menuitem", { name: "Move to Background" });
    const firstCopyButton = within(menu).getByRole("menuitem", { name: "Copy Connect Command" });
    expect(moveButton).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Close" })).toBeTruthy();
    expect(document.activeElement).toBe(firstCopyButton);

    fireEvent.keyDown(firstCopyButton, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Actions for matrix-main" })).toBeNull();
    expect(document.activeElement).toBe(within(actions).getByRole("button", { name: "More actions for matrix-main" }));

    menu = await openSessionContextMenu("main");
    const copyButton = within(menu).getByRole("menuitem", { name: "Copy Connect Command" });
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
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Connect Command" }));
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
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Connect Command" }));
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
    let latestSeq = 2;
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
                latestSeq,
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
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    const deleteButton = within(dialog).getByRole("button", { name: "Delete" });
    expect(document.activeElement).toBe(cancelButton);

    deleteButton.focus();
    expect(document.activeElement).toBe(deleteButton);
    latestSeq = 3;
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(screen.getByRole("dialog", { name: "Close this session?" })).getByText("active · 2 unread")).toBeTruthy();
    expect(document.activeElement).toBe(deleteButton);

    await act(async () => {
      fireEvent.click(cancelButton);
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
    expect(screen.getByTestId("terminal-session-card-main").style.background).toBe("var(--terminal-drawer-card-selected-bg)");
    expect(screen.getByTestId("terminal-session-card-main").style.border).toBe("1px solid var(--terminal-drawer-card-border)");
    expect(screen.getByTestId("terminal-session-card-main").style.boxShadow).not.toContain("selected-ring");
    expect(screen.getByTestId("terminal-session-name-main").style.color).toBe("var(--terminal-drawer-fg)");
    expect(screen.getByTestId("terminal-session-name-docs").style.color).toBe("var(--terminal-drawer-muted)");

    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-session-row-docs"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-session-row-main").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("terminal-session-row-main").getAttribute("data-selected")).toBe("false");
    expect(screen.getByTestId("terminal-session-row-docs").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("terminal-session-card-main").style.background).toBe("var(--terminal-drawer-card-bg)");
    expect(screen.getByTestId("terminal-session-card-docs").style.background).toBe("var(--terminal-drawer-card-selected-bg)");
    expect(screen.getByTestId("terminal-session-name-main").style.color).toBe("var(--terminal-drawer-muted)");
    expect(screen.getByTestId("terminal-session-name-docs").style.color).toBe("var(--terminal-drawer-fg)");

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

  it("creates a shell from the primary new-session button without opening the menu", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New shell session" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("menu", { name: "New session menu" })).toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") &&
      init?.method === "POST"
    ))).toBe(true);
  });

  it("opens the new-session menu from a grouped split-button dropdown trigger", async () => {
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
    expect(within(menu).getByRole("menuitem", { name: /Claude Code.*Status unavailable/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Codex.*Status unavailable/i })).toBeTruthy();
    expect(within(menu).queryByText("Install")).toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") &&
      init?.method === "POST"
    ))).toBe(false);

    const splitButton = screen.getByTestId("terminal-new-session-split-button");
    const primaryAction = screen.getByRole("button", { name: "New shell session" });
    const dropdownTrigger = screen.getByRole("button", { name: "Choose session type" });
    const dropdownChevron = screen.getByTestId("terminal-new-session-dropdown-chevron");

    expect(splitButton.classList.contains("terminal-new-session-split-button")).toBe(true);
    expect(splitButton.getAttribute("data-slot")).toBe("button-group");
    expect(splitButton.getAttribute("role")).toBe("group");
    expect(splitButton.getAttribute("aria-label")).toBe("New session actions");
    expect(primaryAction.classList.contains("terminal-new-session-primary-action")).toBe(true);
    expect(dropdownTrigger.classList.contains("terminal-new-session-dropdown-trigger")).toBe(true);
    expect(primaryAction.classList.contains("bg-primary")).toBe(false);
    expect(dropdownTrigger.classList.contains("bg-primary")).toBe(false);
    expect(primaryAction.getAttribute("data-variant")).toBeNull();
    expect(dropdownTrigger.getAttribute("data-variant")).toBeNull();
    expect(primaryAction.nextElementSibling).toBe(dropdownTrigger);
    expect(dropdownTrigger.style.position).toBe("");
    expect(dropdownTrigger.getAttribute("data-state")).toBe("open");
    expect(dropdownChevron.classList.contains("terminal-new-session-dropdown-chevron")).toBe(true);
    expect(menu.classList.contains("terminal-new-session-menu")).toBe(true);

    await act(async () => {
      fireEvent.click(dropdownTrigger);
      await Promise.resolve();
    });

    expect(screen.queryByRole("menu", { name: "New session menu" })).toBeNull();
    expect(dropdownTrigger.getAttribute("data-state")).toBe("closed");
  });

  it("uses one primary surface for every desktop drawer header control", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const controls = [
      screen.getByTestId("terminal-new-session-split-button"),
      screen.getByRole("button", { name: "Refresh sessions" }),
      screen.getByRole("button", { name: "Hide sessions drawer" }),
    ];

    for (const control of controls) {
      expect(control.classList.contains("terminal-drawer-primary-control")).toBe(true);
      expect(control.getAttribute("style") ?? "").not.toContain("--terminal-drawer-button-");
    }

    const primaryControlStyles = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .find((styles) => styles.includes(".terminal-drawer-primary-control"));
    expect(primaryControlStyles).toContain("background: var(--terminal-drawer-primary-button-bg)");
    expect(primaryControlStyles).toContain("color: var(--terminal-drawer-primary-button-fg)");
  });

  it("opens split-button session choices with ArrowDown from the primary action", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const primaryAction = screen.getByRole("button", { name: "New shell session" });
    const dropdownTrigger = screen.getByRole("button", { name: "Choose session type" });

    await act(async () => {
      fireEvent.keyDown(primaryAction, { key: "ArrowDown" });
      await Promise.resolve();
    });

    expect(screen.getByRole("menu", { name: "New session menu" })).toBeTruthy();
    expect(dropdownTrigger.getAttribute("data-state")).toBe("open");
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
    await vi.waitFor(() => {
      expect(within(menu).getAllByText("Status unavailable")).toHaveLength(4);
    });
    expect(within(menu).queryByText("Install")).toBeNull();
  });

  it("opens two-word shell sessions from the new-session menu", async () => {
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

    const createdShell = createCalls.find((body) => TWO_WORD_SESSION_NAME_PATTERN.test(body.name));
    expect(createdShell).toBeTruthy();
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: createdShell?.name,
      },
    });
  });

  it("retries shell name collisions with fresh two-word names only", async () => {
    const postedNames: string[] = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve(mockJsonResponse([]));
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve(mockJsonResponse({ ok: true }));
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve(mockJsonResponse({}));
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string };
        if (body.name === "main") {
          return Promise.resolve(mockJsonResponse({ name: "main", created: true }, 201));
        }
        if (typeof body.name === "string") postedNames.push(body.name);
        if (postedNames.length < 10) {
          return Promise.resolve(mockJsonResponse({ error: { code: "session_exists", message: "Request failed" } }, 409));
        }
        return Promise.resolve(mockJsonResponse({ name: body.name, created: true }, 201));
      }
      if (url.endsWith("/api/terminal/sessions")) {
        return Promise.resolve(mockJsonResponse({
          sessions: postedNames.length >= 10 ? [{ name: postedNames[9], status: "active" }] : [],
        }));
      }
      return Promise.resolve(mockJsonResponse({}));
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await chooseNewSessionMenuItem(/Shell/);
    });

    await vi.waitFor(() => expect(postedNames).toHaveLength(10));
    expect(postedNames).toEqual(Array.from({ length: 10 }, () => expect.stringMatching(TWO_WORD_SESSION_NAME_PATTERN)));
    expect(postedNames.every((name) => name.split("-").length === 2)).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: postedNames[9],
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
    const newSessionButton = screen.getByRole("button", { name: "New shell session" });
    const sessionTypeButton = screen.getByRole("button", { name: "Choose session type" });
    const menu = screen.getByRole("menu", { name: "New session menu" });

    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /^Shell(?:\s+⌘T)?$/i }));
      await Promise.resolve();
    });

    expect(newSessionButton).toHaveProperty("disabled", true);
    expect(sessionTypeButton).toHaveProperty("disabled", true);
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
    expect(screen.getByRole("button", { name: "Rename matrix-main" })).toBeTruthy();
    const moreButton = within(actions).getByRole("button", { name: "More actions for matrix-main" });
    expect(moreButton.style.width).toBe("24px");
    expect(moreButton.style.height).toBe("24px");
    expect(screen.queryByRole("button", { name: "Move to Background" })).toBeNull();
    const menu = await openSessionContextMenu("main");
    expect(menu.style.minWidth).toBe("152px");
    expect(menu.style.padding).toBe("5px");
    const moveItem = within(menu).getByRole("menuitem", { name: "Move to Background" });
    const copyItem = within(menu).getByRole("menuitem", { name: "Copy Connect Command" });
    const closeItem = within(menu).getByRole("menuitem", { name: "Close" });
    expect(within(menu).getAllByRole("menuitem")).toEqual([copyItem, moveItem, closeItem]);
    expect(within(menu).getByRole("separator").nextElementSibling).toBe(closeItem);
    expect(closeItem.dataset.tone).toBe("destructive");
    expect(closeItem.style.color).toBe("var(--terminal-drawer-destructive-fg)");
    expect(moveItem.style.height).toBe("28px");
    expect(document.activeElement).toBe(copyItem);
    fireEvent.keyDown(copyItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(moveItem);
    fireEvent.keyDown(moveItem, { key: "End" });
    expect(document.activeElement).toBe(closeItem);
    fireEvent.keyDown(closeItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(copyItem);
    fireEvent.keyDown(copyItem, { key: "ArrowUp" });
    expect(document.activeElement).toBe(closeItem);
    fireEvent.keyDown(closeItem, { key: "Home" });
    expect(document.activeElement).toBe(copyItem);
    fireEvent.keyDown(copyItem, { key: "Tab" });
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
    expect(sidebarShell.dataset.terminalSidebarState).toBe("expanded");
    expect(sidebarShell.style.transition).toContain("width 220ms");
    expect(resizeHandle.style.background).toBe("var(--terminal-drawer-resize-handle-bg)");
    expect(resizeHandle.getAttribute("style")).toContain("--terminal-drawer-resize-handle-bg");
    expect(resizeHandle.getAttribute("style")).not.toContain("--muted-foreground");
    expect(resizeHandle.style.background).not.toContain("transparent");
    expect(resizeHandle.style.background).not.toContain("197, 196, 180");

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const collapsedSidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(collapsedSidebarShell).toBe(sidebarShell);
    expect(collapsedSidebarShell.dataset.terminalSidebarState).toBe("collapsed");
    expect(collapsedSidebarShell.style.width).toBe("76px");
    expect(screen.getByTestId("terminal-collapsed-rail").style.borderRight).toBe("1px solid var(--terminal-drawer-border)");

    const sidebarMotionStyles = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .find((styles) => styles.includes("[data-terminal-sidebar-motion]"));
    expect(sidebarMotionStyles).toContain("@media (prefers-reduced-motion: reduce)");
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
    expect(sidebarShell.style.overflow).toBe("hidden");
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

  it("elevates the collapsed new-session menu above terminal content only while open", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    let sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(sidebarShell.style.overflow).toBe("hidden");
    expect(sidebarShell.style.zIndex).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      await Promise.resolve();
    });

    sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(screen.getByRole("menu", { name: "New session menu" })).toBeTruthy();
    expect(sidebarShell.style.overflow).toBe("visible");
    expect(sidebarShell.style.position).toBe("relative");
    expect(sidebarShell.style.zIndex).toBe("3");

    await act(async () => {
      fireEvent.pointerDown(document.body);
      await Promise.resolve();
    });

    sidebarShell = screen.getByTestId("terminal-sidebar-shell");
    expect(screen.queryByRole("menu", { name: "New session menu" })).toBeNull();
    expect(sidebarShell.style.overflow).toBe("hidden");
    expect(sidebarShell.style.position).toBe("");
    expect(sidebarShell.style.zIndex).toBe("");
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
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Connect Command" }));
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

  it("keeps a fresh terminal empty until the user explicitly creates a session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ tabs: [] }) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: body.name }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("No terminal tabs open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Terminal" })).toBeTruthy();
    expect(screen.getByTestId("terminal-session-group-active").textContent).toContain("Active (0)");
    expect(screen.queryByTestId("terminal-pane-grid")).toBeNull();
    expect(terminalSessionPostBodies()).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const [payload] = terminalSessionPostPayloads();
    expect(payload).toMatchObject({ cwd: "projects" });
    expect(payload?.name).toMatch(TWO_WORD_SESSION_NAME_PATTERN);
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: payload?.name,
    });
  });

  it("opens the first ordered existing shell without creating a replacement", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ tabs: [] }) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "quiet-ember", status: "active" },
              { name: "bright-river", status: "active" },
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

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("quiet-ember");
    expect(terminalSessionPostBodies()).toHaveLength(0);
  });

  it("discards a saved legacy pty layout without creating any replacement session", async () => {
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

    expect(screen.getByText("No terminal tabs open")).toBeTruthy();
    expect(screen.queryByTestId("terminal-pane-grid")).toBeNull();
    expect(terminalSessionPostBodies()).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    ))).toHaveLength(2);
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

  it("does not recreate a deliberately deleted last session on remount", async () => {
    let deleted = false;
    let savedLayout: { tabs: unknown[]; activeTabId: string } = { tabs: [], activeTabId: "" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        savedLayout = JSON.parse(String(init.body)) as typeof savedLayout;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => savedLayout });
      }
      if (url.includes("/api/terminal/sessions/quiet-ember") && init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: deleted ? [] : [{ name: "quiet-ember", status: "active", placement: "active", tabs: [] }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const firstMount = render(<TerminalApp />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const menu = await openSessionContextMenu("quiet-ember", "quiet-ember");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Close this session?" })).getByRole("button", { name: "Delete" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(deleted).toBe(true);
    expect(savedLayout.tabs).toEqual([]);
    firstMount.unmount();
    paneGridSpy.mockClear();
    vi.mocked(global.fetch).mockClear();

    render(<TerminalApp />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("No terminal tabs open")).toBeTruthy();
    expect(screen.queryByTestId("terminal-pane-grid")).toBeNull();
    expect(terminalSessionPostBodies()).toHaveLength(0);
  });

  it("settles into the empty state without creating a session when bootstrap reads fail", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.reject(new Error("layout unavailable"));
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.reject(new Error("sessions unavailable"));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("No terminal tabs open")).toBeTruthy();
    expect(screen.queryByTestId("terminal-pane-grid")).toBeNull();
    expect(terminalSessionPostBodies()).toHaveLength(0);
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

  it("creates toolbar shell launches as two-word canonical shell sessions", async () => {
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
      TWO_WORD_SESSION_NAME_PATTERN.test(JSON.parse(init.body).name)
    ));
    expect(createCall).toBeTruthy();
    const body = JSON.parse(createCall?.[1]?.body as string) as { name: string; cwd: string };
    expect(body).toMatchObject({ cwd: "projects" });
    expect(body.name).toMatch(TWO_WORD_SESSION_NAME_PATTERN);

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
    expect(screen.getByRole("button", { name: "Rename matrix-main" })).toBeTruthy();
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
    expect(document.activeElement).toBe(screen.getByTestId("terminal-session-name-bench"));
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
    expect(screen.queryByRole("button", { name: "Copy Connect Command" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Copy Connect Command" })).toBeNull();

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
    const openCodeItem = within(menu).getByRole("menuitem", { name: /OpenCode.*Install/ });
    expect(openCodeItem.style.background).toBe("transparent");
    expect(within(openCodeItem).getByText("OpenCode").style.color).toBe("var(--terminal-drawer-fg)");
    expect(within(menu).getByTestId("terminal-agent-logo-opencode").style.opacity).toBe("1");
    expect(within(menu).getByTestId("terminal-agent-logo-claude")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-codex")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-opencode")).toBeTruthy();
    expect(within(menu).getByTestId("terminal-agent-logo-pi")).toBeTruthy();
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-claude"), "/agent-logos/claude-code.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-codex"), "/agent-logos/codex.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-opencode"), "/agent-logos/opencode-white.png");
    expectOptimizedImageSrc(within(menu).getByTestId("terminal-agent-logo-image-pi"), "/agent-logos/pi-coding-agent.png");
  });

  it("shows status unavailable without install actions when agent status cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.resolve({ ok: true, json: async () => ({ agents: [] }) });
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
      expect(within(menu).getAllByText("Status unavailable")).toHaveLength(4);
    });
    expect(within(menu).queryByText("Install")).toBeNull();
  });

  it("launches an agent directly when status is unavailable instead of running npm install", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        return Promise.reject(new Error("gateway unavailable"));
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

    await chooseNewSessionMenuItemAfterStatus(/Claude Code.*Status unavailable/);

    expectTerminalCreatePayloadForCommand("claude");
    expect(terminalSessionPostPayloads().some((payload) => String(payload.cmd).includes("npm install"))).toBe(false);
  });

  it("keeps a known installed agent launchable while a refresh is still checking", async () => {
    let agentStatusCalls = 0;
    const pendingRefresh = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        agentStatusCalls += 1;
        if (agentStatusCalls > 1) return pendingRefresh;
        return Promise.resolve(mockJsonResponse({
          agents: [
            { id: "claude", installState: "installed", installed: true },
            { id: "codex", installState: "installed", installed: true },
            { id: "opencode", installState: "installed", installed: true },
            { id: "pi", installState: "installed", installed: true },
          ],
        }));
      }
      if (url.includes("/api/files/tree")) return Promise.resolve(mockJsonResponse([]));
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") return Promise.resolve(mockJsonResponse({ ok: true }));
      if (url.includes("/api/terminal/layout")) return Promise.resolve(mockJsonResponse({}));
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string };
        return Promise.resolve(mockJsonResponse({ name: body.name, created: true }, 201));
      }
      if (url.includes("/api/terminal/sessions")) return Promise.resolve(mockJsonResponse({ sessions: [] }));
      return Promise.resolve(mockJsonResponse({}));
    }));

    render(<TerminalApp />);
    await vi.waitFor(() => expect(agentStatusCalls).toBe(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await openNewSessionMenu();
    const menu = screen.getByRole("menu", { name: "New session menu" });
    expect(within(menu).getByRole("menuitem", { name: /^Claude Code$/ })).toBeTruthy();
    expect(within(menu).queryByText("Install")).toBeNull();

    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Claude Code$/ }));
    await vi.waitFor(() => expectTerminalCreatePayloadForCommand("claude"));
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

  it("ignores an older agent-status response that arrives after a newer refresh", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let agentStatusCalls = 0;
    const installedBody = {
      agents: [
        { id: "claude", installState: "installed", installed: true },
        { id: "codex", installState: "installed", installed: true },
        { id: "opencode", installState: "installed", installed: true },
        { id: "pi", installState: "installed", installed: true },
      ],
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents")) {
        agentStatusCalls += 1;
        return agentStatusCalls === 1 ? firstResponse : Promise.resolve(mockJsonResponse(installedBody));
      }
      if (url.includes("/api/files/tree")) return Promise.resolve(mockJsonResponse([]));
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") return Promise.resolve(mockJsonResponse({ ok: true }));
      if (url.includes("/api/terminal/layout")) return Promise.resolve(mockJsonResponse({}));
      return Promise.resolve(mockJsonResponse({ sessions: [] }));
    }));

    render(<TerminalApp />);
    await vi.waitFor(() => expect(agentStatusCalls).toBe(1));
    await openNewSessionMenu();

    const menu = screen.getByRole("menu", { name: "New session menu" });
    await vi.waitFor(() => {
      expect(within(menu).getByRole("menuitem", { name: /^Claude Code$/ })).toBeTruthy();
    });

    resolveFirst(mockJsonResponse({
      agents: (["claude", "codex", "opencode", "pi"] as const)
        .map((id) => ({ id, installState: "missing", installed: false })),
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(within(menu).getByRole("menuitem", { name: /^Claude Code$/ })).toBeTruthy();
    expect(within(menu).queryByText("Install")).toBeNull();
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

    await chooseNewSessionMenuItemAfterStatus(/^Claude Code$/);

    const claudePayload = expectTerminalCreatePayloadForCommand("claude");
    expect(claudePayload.agent).toBe("claude");
    await vi.waitFor(() => {
      expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
        paneTree: {
          sessionId: claudePayload.name,
        },
      });
    });

    await chooseNewSessionMenuItemAfterStatus(/^Codex$/);

    const codexPayload = expectTerminalCreatePayloadForCommand("codex");
    expect(codexPayload.agent).toBe("codex");
    await vi.waitFor(() => {
      expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
        paneTree: {
          sessionId: codexPayload.name,
          compatMode: "codex-tui",
        },
      });
    });

    await chooseNewSessionMenuItemAfterStatus(/^OpenCode$/);

    const opencodePayload = expectTerminalCreatePayloadForCommand("opencode");
    expect(opencodePayload.agent).toBe("opencode");
    await vi.waitFor(() => {
      expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
        paneTree: {
          sessionId: opencodePayload.name,
        },
      });
    });

    await chooseNewSessionMenuItemAfterStatus(/^Pi$/);

    const piPayload = expectTerminalCreatePayloadForCommand("pi");
    expect(piPayload.agent).toBe("pi");
    await vi.waitFor(() => {
      expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
        paneTree: {
          sessionId: piPayload.name,
        },
      });
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
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string; cwd?: string; cmd?: string };
        if (body.cmd === "claude" && body.cwd === "projects") {
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

    await chooseNewSessionMenuItemAfterStatus(/^Claude Code$/);

    await vi.waitFor(() => {
      const bodies = terminalSessionPostBodies()
        .map((body) => JSON.parse(body) as { name: string; cwd: string; cmd?: string })
        .filter((body) => body.cmd === "claude");
      expect(bodies.map((body) => body.cwd)).toEqual(["projects", "~"]);
      expect(bodies.every((body) => body.cmd === "claude")).toBe(true);
      expect(bodies.map((body) => body.name)).toEqual([
        expect.stringMatching(TWO_WORD_SESSION_NAME_PATTERN),
        expect.stringMatching(TWO_WORD_SESSION_NAME_PATTERN),
      ]);
      expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
        paneTree: {
          cwd: "~",
          sessionId: bodies[1]?.name,
        },
      });
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

    const claudeInstallPayload = expectTerminalCreatePayloadForCommand(/^sh -lc .*@anthropic-ai\/claude-code@latest/);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: claudeInstallPayload.name,
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Codex.*Install/);
    });

    const codexInstallPayload = expectTerminalCreatePayloadForCommand(/^sh -lc .*@openai\/codex@/);
    const codexInstallPaneProps = paneGridSpy.mock.lastCall?.[0] as { paneTree: { sessionId?: string; compatMode?: string } };
    expect(codexInstallPaneProps).toMatchObject({
      paneTree: {
        sessionId: codexInstallPayload.name,
      },
    });
    expect(codexInstallPaneProps.paneTree.compatMode).toBeUndefined();

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/OpenCode.*Install/);
    });

    const opencodeInstallPayload = expectTerminalCreatePayloadForCommand(/^sh -lc .*opencode-ai@latest/);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: opencodeInstallPayload.name,
      },
    });

    await act(async () => {
      await chooseNewSessionMenuItemAfterStatus(/Pi.*Install/);
    });

    const piInstallPayload = expectTerminalCreatePayloadForCommand(/^sh -lc .*--ignore-scripts.*@earendil-works\/pi-coding-agent@latest/);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: piInstallPayload.name,
      },
    });
  });
});
