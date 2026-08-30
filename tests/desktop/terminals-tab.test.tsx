// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalsTab from "../../desktop/src/renderer/src/features/terminal/TerminalsTab";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";
import { useTerminalAppearance } from "../../desktop/src/renderer/src/stores/terminal-appearance";

const terminalMounts = vi.hoisted(() => new Map<string, number>());
const installedAgents = {
  agents: ["claude", "codex", "opencode", "pi"].map((id) => ({ id, installState: "installed" })),
};
const terminalPreferencesGet = vi.fn(async (path: string) => (
  path === "/api/agents" ? installedAgents : { preferences: { shellThemeId: "dark" } }
));
const terminalPreferencesPut = vi.fn(async () => ({ preferences: { shellThemeId: "dark" } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: ({
    sessionName,
    active,
    visualScale,
  }: {
    sessionName: string;
    active?: boolean;
    visualScale?: number;
  }) => {
    const themeMode = useAppearance((state) => state.mode);
    const terminalThemeId = useTerminalAppearance((state) => state.themeId);
    React.useEffect(() => {
      terminalMounts.set(sessionName, (terminalMounts.get(sessionName) ?? 0) + 1);
      return () => {
        terminalMounts.set(sessionName, (terminalMounts.get(sessionName) ?? 1) - 1);
      };
    }, [sessionName]);
    return (
      <div
        data-testid={`terminal-view-${sessionName}`}
        data-active={active ? "true" : "false"}
        data-visual-scale={visualScale}
        data-theme-mode={themeMode}
        data-terminal-theme-id={terminalThemeId}
      >
        Terminal {sessionName}
      </div>
    );
  },
}));

function renderTab(active = true, visualScale = 1) {
  return render(
    <Tooltip.Provider>
      <TerminalsTab active={active} visualScale={visualScale} />
    </Tooltip.Provider>,
  );
}

describe("TerminalsTab", () => {
  beforeEach(() => {
    terminalMounts.clear();
    terminalPreferencesGet.mockReset();
    terminalPreferencesGet.mockImplementation(async (path: string) => (
      path === "/api/agents" ? installedAgents : { preferences: { shellThemeId: "dark" } }
    ));
    terminalPreferencesPut.mockClear();
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        get: terminalPreferencesGet,
        put: terminalPreferencesPut,
      } as never,
    });
    useSessions.setState({
      sessions: [
        { name: "Workspace Only", attachName: "workspace-only", status: "active", source: "workspace" },
      ],
      create: vi.fn().mockResolvedValue(null),
    });
    useShellSessions.setState({
      ...useShellSessions.getInitialState(),
      load: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ name: "matrix-created", status: "active" }),
      deleteSession: vi.fn().mockResolvedValue(true),
      rename: vi.fn().mockResolvedValue(true),
      reorder: vi.fn().mockResolvedValue(true),
      patchUiState: vi.fn().mockResolvedValue(true),
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.setState({
      tabs: [],
      activeTabId: null,
      openTab: vi.fn(),
    });
    useAppearance.setState({
      ...useAppearance.getInitialState(),
      mode: "dark",
      hydrated: true,
    }, true);
    useTerminalAppearance.setState({
      ...useTerminalAppearance.getInitialState(),
      themeId: "dark",
      hydrated: true,
    }, true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows only the empty session card when no terminal sessions exist", () => {
    useShellSessions.setState({ sessions: [], loading: false, error: null });

    renderTab();

    expect(screen.getByText("No shell sessions yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search terminal sessions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New shell" })).toBeNull();
    expect(document.querySelector("[data-terminal-overview] h1")).toBeNull();
  });

  it("changes only the inner shell palette while native Terminal chrome stays on Desktop tokens", async () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active" }],
      loading: false,
      error: null,
    });

    renderTab();

    const terminalApp = screen.getByTestId("desktop-terminal-app");
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-bg")).toBe("");
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-theme-mode")).toBe("dark");
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-terminal-theme-id")).toBe("dark");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Shell theme" }), { button: 0, ctrlKey: false });
    const rainbowTheme = (await screen.findByText("P10k Rainbow")).closest<HTMLElement>("[role='menuitemradio']");
    expect(rainbowTheme).not.toBeNull();
    fireEvent.click(rainbowTheme!);

    await waitFor(() => expect(useTerminalAppearance.getState().themeId).toBe("powerlevel10k-rainbow"));
    expect(terminalPreferencesPut).toHaveBeenCalledWith("/api/terminal/preferences", {
      shellThemeId: "powerlevel10k-rainbow",
    });
    expect(terminalApp.style.getPropertyValue("--terminal-drawer-bg")).toBe("");
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-theme-mode")).toBe("dark");
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-terminal-theme-id")).toBe("powerlevel10k-rainbow");
    expect(useAppearance.getState().mode).toBe("dark");
  });

  it("disables shell theme selection while the runtime API is unavailable", () => {
    useConnection.setState({ api: null });
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active" }],
      loading: false,
      error: null,
    });

    renderTab();

    expect(screen.getByRole("button", { name: "Shell theme" }).hasAttribute("disabled")).toBe(true);
  });

  it("opens the most recently active session instead of showing an unselected overview", async () => {
    useShellSessions.setState({
      sessions: [
        { name: "older-shell", status: "active", updatedAt: "2026-08-26T08:00:00.000Z" },
        { name: "latest-shell", status: "active", updatedAt: "2026-08-26T09:00:00.000Z" },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByTestId("terminal-view-latest-shell").getAttribute("data-active")).toBe("true"));
    expect(screen.queryByTestId("terminal-view-older-shell")).toBeNull();
    expect((screen.getByRole("button", { name: "Open latest-shell" }) as HTMLElement).getAttribute("aria-current")).toBe("true");
  });

  it("renders only canonical shell sessions in the OS View sidebar", () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-active", status: "active", placement: "active" },
        { name: "matrix-bg", status: "active", placement: "background" },
        { name: "matrix-open", status: "active" },
      ],
    });
    useTabs.setState({
      tabs: [{ id: "tab-open", kind: "terminal", title: "Open", sessionName: "matrix-open", closable: true }],
      activeTabId: "tab-open",
    });

    renderTab();

    expect(screen.getByRole("button", { name: "Open matrix-active" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-bg" })).toBeTruthy();
    expect(screen.queryByText("Workspace Only")).toBeNull();
  });

  it("does not duplicate the Mission Control breadcrumb inside the Terminal surface", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();

    expect(screen.queryByRole("navigation", { name: "Terminal breadcrumb" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));

    expect(screen.queryByRole("navigation", { name: "Terminal breadcrumb" })).toBeNull();
  });

  it("places the shell theme picker beside the new-session controls in the sidebar", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active", createdAt: "2026-08-26T09:41:00.000Z" }],
    });

    renderTab();

    const header = screen.getByRole("banner");
    expect(header.className).toContain("justify-between");
    expect(screen.getByRole("heading", { name: "matrix-main" }).className).toContain("text-xs");
    expect(screen.getByText(/Started at .*main computer/).className).toContain("text-xs");
    const active = screen.getByText("Active");
    expect(active.className).toContain("h-5");
    expect((active as HTMLElement).style.background).toBe("var(--bg-selected)");
    const themeButton = screen.getByRole("button", { name: "Shell theme" });
    const sidebarActions = document.querySelector("[data-terminal-sidebar-header-actions]");
    const headerActions = header.querySelector("[data-terminal-header-actions]");
    expect(headerActions?.contains(active)).toBe(true);
    expect(headerActions?.contains(themeButton)).toBe(false);
    expect(sidebarActions?.contains(themeButton)).toBe(true);
    expect(sidebarActions?.contains(screen.getByRole("button", { name: "New shell session" }))).toBe(true);
    expect(sidebarActions?.classList.contains("no-drag")).toBe(true);
    expect(themeButton.className).toContain("size-7");
    expect(themeButton.textContent).toBe("");
    expect(themeButton.closest("footer")).toBeNull();
    expect(screen.queryByRole("group", { name: "Terminal theme" })).toBeNull();
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-theme-mode"))
      .toBe("dark");
  });

  it("leaves loading ownership to MissionControl and reconciles a manual retry", async () => {
    const load = vi.fn().mockResolvedValue([]);
    useShellSessions.setState({ sessions: [], loading: false, error: "network", load });
    useTabs.setState(useTabs.getInitialState(), true);
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "matrix-deleted",
      title: "matrix-deleted",
    });

    renderTab();

    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry terminal sessions" }));

    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home]);
    expect(useTabs.getState().activeTabId).toBe(home);
  });

  it("opens the Figma-aligned session detail without a Terminal-local back control", () => {
    useShellSessions.setState({
      sessions: [{
        name: "matrix-main",
        status: "active",
        placement: "active",
        createdAt: "2026-08-12T09:30:00.000Z",
      }],
    });

    renderTab();

    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" }).getAttribute("aria-current"))
      .toBe("true");

    expect(screen.queryByRole("navigation", { name: "Terminal breadcrumb" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to terminal sessions" })).toBeNull();
    expect(screen.getByRole("heading", { name: "matrix-main" })).toBeTruthy();
    expect(screen.getByText(/Started at .*main computer/)).toBeTruthy();
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-active")).toBe("true");
    expect(terminalMounts.get("matrix-main")).toBe(1);
  });

  it("uses the Figma session frame without a secondary session rail", () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-main", status: "active", placement: "active" },
        { name: "matrix-other", status: "active", placement: "active" },
      ],
    });

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));

    expect(screen.queryByRole("navigation", { name: "Terminal session switcher" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse terminal sessions" })).toBeNull();
    const terminalDetail = screen.getByTestId("terminal-view-matrix-main")
      .closest("[data-terminal-detail]");
    expect(terminalDetail?.className.split(/\s+/)).not.toContain("p-3");
    expect(terminalDetail?.className.split(/\s+/)).not.toContain("gap-3");
    const terminalViewport = screen.getByTestId("terminal-view-matrix-main")
      .closest("[data-terminal-viewport]");
    expect(terminalViewport?.className.split(/\s+/)).not.toContain("rounded-lg");
    expect(terminalViewport?.className.split(/\s+/)).not.toContain("border");
    expect(terminalViewport?.className).toContain("flex");

    expect(terminalViewport?.className).toContain("flex");
  });

  it("fully contains cached session chrome and terminal output while the Terminal route is inactive", () => {
    useShellSessions.setState({
      sessions: [{
        name: "matrix-main",
        status: "active",
        placement: "active",
        createdAt: "2026-08-12T09:30:00.000Z",
      }],
    });

    const { rerender } = renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
    const terminal = screen.getByTestId("terminal-view-matrix-main");
    const sessionPane = terminal.closest("section");

    expect(sessionPane?.style.display).toBe("flex");
    expect(sessionPane?.style.visibility).toBe("visible");
    expect(sessionPane?.style.pointerEvents).toBe("auto");
    expect(terminalMounts.get("matrix-main")).toBe(1);

    rerender(
      <Tooltip.Provider>
        <TerminalsTab active={false} />
      </Tooltip.Provider>,
    );

    expect(sessionPane?.style.display).toBe("none");
    expect(sessionPane?.style.visibility).toBe("hidden");
    expect(sessionPane?.style.pointerEvents).toBe("none");
    expect(sessionPane?.getAttribute("aria-hidden")).toBe("true");
    expect(sessionPane?.hasAttribute("inert")).toBe(true);
    expect(terminal.getAttribute("data-active")).toBe("false");
    expect(terminalMounts.get("matrix-main")).toBe(1);

    rerender(
      <Tooltip.Provider>
        <TerminalsTab active />
      </Tooltip.Provider>,
    );

    expect(sessionPane?.style.display).toBe("flex");
    expect(sessionPane?.style.visibility).toBe("visible");
    expect(terminal.getAttribute("data-active")).toBe("true");
    expect(terminalMounts.get("matrix-main")).toBe(1);
  });

  it("forwards Canvas visual scale without remounting retained terminal sessions", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    const { rerender } = renderTab(true, 0.5);
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
    const terminal = screen.getByTestId("terminal-view-matrix-main");

    expect(terminal.getAttribute("data-visual-scale")).toBe("0.5");
    expect(terminalMounts.get("matrix-main")).toBe(1);

    for (const visualScale of [1, 2]) {
      rerender(
        <Tooltip.Provider>
          <TerminalsTab active visualScale={visualScale} />
        </Tooltip.Provider>,
      );
      expect(screen.getByTestId("terminal-view-matrix-main")).toBe(terminal);
      expect(terminal.getAttribute("data-visual-scale")).toBe(String(visualScale));
      expect(terminalMounts.get("matrix-main")).toBe(1);
    }
  });

  it("keeps a background Terminal window painted while releasing interaction and its live attachment", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    const { rerender } = renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
    const terminal = screen.getByTestId("terminal-view-matrix-main");
    const sessionPane = terminal.closest("section");

    rerender(
      <Tooltip.Provider>
        <TerminalsTab active={false} visible />
      </Tooltip.Provider>,
    );

    expect(sessionPane?.style.display).toBe("flex");
    expect(sessionPane?.style.visibility).toBe("visible");
    expect(sessionPane?.style.pointerEvents).toBe("none");
    expect(sessionPane?.hasAttribute("inert")).toBe(true);
    expect(terminal.getAttribute("data-active")).toBe("false");
    expect(terminalMounts.get("matrix-main")).toBe(1);
  });

  it("does not promote canonical sessions that are only opened", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("primary|operator|1");
    useShellSessions.setState({
      sessions: [
        { name: "matrix-one", status: "active", placement: "active" },
        { name: "matrix-two", status: "active", placement: "active" },
      ],
    });

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open matrix-one" }));
    act(() => useTabs.getState().requestTerminalSession("matrix-two"));
    act(() => useTabs.getState().requestTerminalSession("matrix-one"));
    expect(terminalMounts.get("matrix-one")).toBe(1);
    expect(terminalMounts.get("matrix-two")).toBe(1);
  });

  it("reopens a requested canonical detail from its mounted cache without remounting", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));

    act(() => {
      useTabs.setState({
        terminalSessionRequest: { sessionName: "matrix-main", requestId: 1 },
      });
    });

    expect(screen.getByRole("heading", { name: "matrix-main" })).toBeTruthy();
    expect(terminalMounts.get("matrix-main")).toBe(1);
  });

  it("keeps a requested Recent pending until the canonical session load provides it", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().requestTerminalSession("matrix-delayed");
    useShellSessions.setState({
      sessions: [],
      loading: true,
    });

    renderTab();

    expect(useTabs.getState().terminalSessionRequest).toMatchObject({ sessionName: "matrix-delayed" });
    expect(screen.queryByTestId("terminal-view-matrix-delayed")).toBeNull();

    act(() => {
      useShellSessions.setState({
        sessions: [{ name: "matrix-delayed", status: "active", placement: "active" }],
        loading: false,
      });
    });

    expect(screen.getByRole("heading", { name: "matrix-delayed" })).toBeTruthy();
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("keeps a requested Recent pending during a create-triggered canonical refresh", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().requestTerminalSession("matrix-created");
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      loading: false,
      creating: true,
      error: null,
      loadSequence: 2,
    });

    renderTab();

    expect(useTabs.getState().terminalSessionRequest).toMatchObject({
      sessionName: "matrix-created",
    });

    act(() => {
      useShellSessions.setState({
        sessions: [
          { name: "matrix-created", status: "active", placement: "active" },
          { name: "matrix-main", status: "active", placement: "active" },
        ],
        creating: false,
      });
    });

    expect(screen.getByRole("heading", { name: "matrix-created" })).toBeTruthy();
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("bounds preserved terminal buffers to the eight most recently opened sessions", () => {
    useShellSessions.setState({
      sessions: Array.from({ length: 9 }, (_, index) => ({
        name: `matrix-${index + 1}`,
        status: "active" as const,
        placement: "active" as const,
      })),
    });

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open matrix-1" }));
    for (let index = 2; index <= 9; index += 1) {
      act(() => useTabs.getState().requestTerminalSession(`matrix-${index}`));
    }

    expect(screen.queryByTestId("terminal-view-matrix-1")).toBeNull();
    expect(terminalMounts.get("matrix-1")).toBe(0);
    for (let index = 2; index <= 9; index += 1) {
      expect(screen.getByTestId(`terminal-view-matrix-${index}`)).toBeTruthy();
    }
  });

  it("unmounts cached terminal detail after an authoritative snapshot deletes it", async () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      loading: false,
      error: null,
      loadSequence: 1,
      authoritativeRevision: 1,
    });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
    expect(terminalMounts.get("matrix-main")).toBe(1);

    act(() => {
      useShellSessions.setState({
        sessions: [],
        loading: false,
        error: null,
        loadSequence: 2,
        authoritativeRevision: 2,
      });
    });

    await waitFor(() => expect(screen.queryByTestId("terminal-view-matrix-main")).toBeNull());
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    expect(terminalMounts.get("matrix-main")).toBe(0);
  });

  it("uses the Figma sidebar toolbar without legacy list controls", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();

    expect(screen.getByRole("heading", { name: "Terminal" }).className).toContain("text-base");
    expect(screen.getByRole("list", { name: "Terminal sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New shell session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose session type" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select terminal sessions" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search terminal sessions" })).toBeNull();
  });

  it("keeps delete and connect actions in one non-overlapping overflow menu", async () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();

    expect(screen.queryByRole("button", { name: "Delete matrix-main" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-main" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "Copy connect command" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("opens the same session actions menu when a terminal row is right-clicked", async () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open matrix-main" }));

    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy connect command" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("pins and unpins sessions from the shared overflow menu and keeps pinned sessions first", async () => {
    const patchUiState = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [
        { name: "matrix-later", status: "active" },
        { name: "matrix-pinned", status: "active", pinned: true },
      ],
      patchUiState,
    });

    renderTab();

    const rows = screen.getAllByRole("button", { name: /^Open matrix-/ });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open matrix-pinned",
      "Open matrix-later",
    ]);

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-later" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(patchUiState).toHaveBeenCalledWith(
      useConnection.getState().api,
      "matrix-later",
      { pinned: true },
    ));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open matrix-pinned" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(patchUiState).toHaveBeenCalledWith(
      useConnection.getState().api,
      "matrix-pinned",
      { pinned: false },
    ));
  });

  it("enters rename mode when the terminal session title is double-clicked", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", subtitle: "Fix terminal actions" }],
    });

    renderTab();
    fireEvent.doubleClick(screen.getByTestId("terminal-session-title-matrix-main"));

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Terminal session name" }).value).toBe("matrix-main");
  });

  it("creates Claude, Codex, OpenCode, and Pi sessions from the new-terminal menu", async () => {
    const createShell = vi.fn().mockResolvedValue({ name: "matrix-created", status: "active" });
    useShellSessions.setState({
      create: createShell,
      sessions: [{ name: "matrix-main", status: "active" }],
    });

    renderTab();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose session type" }), { button: 0, ctrlKey: false });

    expect(await screen.findByRole("menuitem", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Codex/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /OpenCode/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Pi/ })).toBeTruthy();
    expect(screen.getByTestId("desktop-terminal-agent-logo-image-claude").getAttribute("src")).toContain("/agent-logos/claude-code.png");
    expect(screen.getByTestId("desktop-terminal-agent-logo-image-codex").getAttribute("src")).toContain("/agent-logos/codex.png");
    expect(screen.getByTestId("desktop-terminal-agent-logo-image-opencode").getAttribute("src")).toContain("/agent-logos/opencode-white.png");
    expect(screen.getByTestId("desktop-terminal-agent-logo-image-pi").getAttribute("src")).toContain("/agent-logos/pi-coding-agent.png");

    fireEvent.click(screen.getByRole("menuitem", { name: /Codex/ }));
    await waitFor(() => expect(createShell).toHaveBeenCalledWith(useConnection.getState().api, {
      cmd: "codex",
      agent: "codex",
    }));
  });

  it("shows an agent session's task title and proper agent icon in its terminal tab", () => {
    useShellSessions.setState({
      sessions: [{
        name: "matrix-codex-fix",
        status: "active",
        agent: "codex",
        subtitle: "Fix terminal tabs",
        model: "gpt-5.6",
        cwd: "projects/matrix-os",
      }],
    });

    renderTab();

    expect(screen.getByText("Fix terminal tabs")).toBeTruthy();
    const metadata = screen.getByTestId("terminal-session-agent-metadata-matrix-codex-fix");
    expect(metadata.textContent).toContain("Codex · gpt-5.6");
    expect(metadata.textContent).toContain("~/projects/matrix-os");
    expect(screen.getByTestId("terminal-session-path-matrix-codex-fix").compareDocumentPosition(
      screen.getByTestId("terminal-session-agent-matrix-codex-fix"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(metadata.contains(screen.getByTestId("desktop-terminal-session-agent-logo-image-codex"))).toBe(true);
  });

  it("keeps agents disabled when installation inventory is unresolved", async () => {
    const createShell = vi.fn().mockResolvedValue({ name: "matrix-created", status: "active" });
    terminalPreferencesGet.mockImplementation(async (path: string) => (
      path === "/api/agents" ? { agents: [] } : { preferences: { shellThemeId: "dark" } }
    ));
    useShellSessions.setState({
      create: createShell,
      sessions: [{ name: "matrix-main", status: "active" }],
    });

    renderTab();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose session type" }), { button: 0, ctrlKey: false });

    const codex = await screen.findByRole("menuitem", { name: /Codex.*Unavailable/ });
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(codex);
    expect(createShell).not.toHaveBeenCalled();
  });

  it("ignores agent inventory that settles after the selected runtime changes", async () => {
    const oldInventory = deferred<unknown>();
    const oldApi = {
      get: vi.fn((path: string) => (
        path === "/api/agents"
          ? oldInventory.promise
          : Promise.resolve({ preferences: { shellThemeId: "dark" } })
      )),
      put: terminalPreferencesPut,
    };
    const newApi = {
      get: vi.fn(async (path: string) => (
        path === "/api/agents"
          ? { agents: [{ id: "codex", installState: "missing" }] }
          : { preferences: { shellThemeId: "dark" } }
      )),
      put: terminalPreferencesPut,
    };
    useConnection.setState({ api: oldApi as never, runtimeSlot: "primary" });
    useShellSessions.setState({ sessions: [{ name: "matrix-main", status: "active" }] });

    renderTab();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose session type" }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(oldApi.get).toHaveBeenCalledWith("/api/agents"));

    act(() => useConnection.setState({ api: newApi as never, runtimeSlot: "secondary" }));
    act(() => oldInventory.resolve({ agents: [{ id: "codex", installState: "installed" }] }));

    const staleCodex = await screen.findByRole("menuitem", { name: /Codex.*Unavailable/ });
    expect(staleCodex.getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose session type" }), { button: 0, ctrlKey: false });

    const currentCodex = await screen.findByRole("menuitem", { name: /Codex.*Install/ });
    expect(currentCodex.getAttribute("aria-disabled")).toBeNull();
    expect(newApi.get).toHaveBeenCalledWith("/api/agents");
  });

  it("masks the previous runtime inventory before passive invalidation runs", async () => {
    const oldApi = {
      get: vi.fn(async (path: string) => (
        path === "/api/agents"
          ? installedAgents
          : { preferences: { shellThemeId: "dark" } }
      )),
      put: terminalPreferencesPut,
    };
    const newApi = {
      get: vi.fn(async (path: string) => (
        path === "/api/agents"
          ? { agents: [{ id: "codex", installState: "missing" }] }
          : { preferences: { shellThemeId: "dark" } }
      )),
      put: terminalPreferencesPut,
    };
    let codexLabelDuringRuntimeCommit = "";

    function RuntimeCommitObserver() {
      const runtimeSlot = useConnection((state) => state.runtimeSlot);
      React.useLayoutEffect(() => {
        if (runtimeSlot !== "secondary") return;
        codexLabelDuringRuntimeCommit = screen
          .getAllByRole("menuitem")
          .find((item) => item.textContent?.includes("Codex"))
          ?.textContent ?? "";
      }, [runtimeSlot]);
      return null;
    }

    useConnection.setState({ api: oldApi as never, runtimeSlot: "primary" });
    useShellSessions.setState({ sessions: [{ name: "matrix-main", status: "active" }] });
    render(
      <Tooltip.Provider>
        <TerminalsTab />
        <RuntimeCommitObserver />
      </Tooltip.Provider>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose session type" }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Codex/ }).textContent).not.toContain("Unavailable"));

    act(() => useConnection.setState({ api: newApi as never, runtimeSlot: "secondary" }));

    expect(codexLabelDuringRuntimeCommit).toContain("Unavailable");
  });

  it("shows the running agent and its current activity in each session row", () => {
    useShellSessions.setState({
      sessions: [{
        name: "matrix-main",
        status: "active",
        agent: "codex",
        model: "gpt-5.4",
        strength: "high",
        subtitle: "Improve terminal session rows",
        lastAction: "Editing terminal sidebar",
      }],
    });

    renderTab();

    const row = screen.getByRole("button", { name: "Open matrix-main" });
    expect(row.textContent).toContain("Codex");
    expect(row.textContent).toContain("gpt-5.4");
    expect(row.textContent).toContain("high");
    expect(row.textContent).toContain("Improve terminal session rows");
    expect(row.textContent).not.toContain("Editing terminal sidebar");
    expect(screen.getByRole("heading", { name: "matrix-main" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Editing terminal sidebar" })).toBeNull();
  });

  it("renames a session and copies its connect command from row actions", async () => {
    const rename = vi.fn().mockResolvedValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active" }],
      rename,
    });

    renderTab();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-main" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy connect command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("matrix shell connect matrix-main"));

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-main" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Terminal session name" });
    fireEvent.change(input, { target: { value: "matrix-renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(rename).toHaveBeenCalledWith(
      useConnection.getState().api,
      "matrix-main",
      "matrix-renamed",
    ));
  });

  it("renders relative activity without lifecycle dots", () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-active", status: "active", visualStatus: "running", updatedAt: new Date(Date.now() - 120_000).toISOString() },
        { name: "matrix-waiting", status: "degraded", visualStatus: "waiting" },
        { name: "matrix-closed", status: "exited", visualStatus: "idle" },
      ],
    });

    renderTab();

    expect(screen.getByRole("button", { name: "Open matrix-active" }).parentElement?.textContent)
      .toContain("2 minutes ago");
    expect(screen.getByRole("button", { name: "Open matrix-waiting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-closed" })).toBeTruthy();
    expect(document.querySelector("[data-terminal-session-status]")).toBeNull();
  });

  it("bounds loading and load-error states in the list surface", () => {
    useShellSessions.setState({ sessions: [], loading: true, error: null });
    const { rerender } = renderTab();

    expect(screen.getByRole("status", { name: "Loading terminal sessions" })).toBeTruthy();

    act(() => {
      useShellSessions.setState({ sessions: [], loading: false, error: "network" });
    });
    rerender(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("heading", { name: "Terminal sessions unavailable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry terminal sessions" })).toBeTruthy();
  });

  it("creates shell sessions from the shell store, not workspace sessions", async () => {
    const createShell = vi.fn().mockResolvedValue({ name: "matrix-created", status: "active" });
    const createWorkspace = vi.fn().mockResolvedValue(null);
    useShellSessions.setState({ create: createShell, sessions: [{ name: "matrix-main", status: "active" }] });
    useSessions.setState({ create: createWorkspace });

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "New shell session" }));

    await waitFor(() => expect(createShell).toHaveBeenCalledWith(useConnection.getState().api));
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("requires confirmation before deleting a shell", async () => {
    const deleteSession = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      deleteSession,
    });

    renderTab();

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-main" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("Delete matrix-main?")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.top).toBe("50%");
    expect(dialog.style.transform).toBe("translate(-50%, -50%)");

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main"));
  });

  it("reconciles open terminal tabs after a successful desktop deletion", async () => {
    const deleteSession = vi.fn(async () => {
      useShellSessions.setState({
        sessions: [{ name: "matrix-live", status: "active", placement: "active" }],
      });
      return true;
    });
    useShellSessions.setState({
      sessions: [
        { name: "matrix-live", status: "active", placement: "active" },
        { name: "matrix-delete", status: "active", placement: "active" },
      ],
      deleteSession,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-delete", title: "matrix-delete" });

    renderTab();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for matrix-delete" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home]));
    expect(useTabs.getState().activeTabId).toBe(home);
  });

  it("never renders workspace-only records as terminal rows", () => {
    useShellSessions.setState({ sessions: [], loading: false, error: null });
    useSessions.setState({
      sessions: [{ name: "Workspace Only", attachName: "workspace-only", status: "active", source: "workspace" }],
    });

    renderTab();

    expect(screen.queryByText("Workspace Only")).toBeNull();
    expect(screen.getByText("No shell sessions yet")).toBeTruthy();
  });

});
