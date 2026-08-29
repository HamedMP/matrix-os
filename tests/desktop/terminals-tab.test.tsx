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
const terminalPreferencesGet = vi.fn(async () => ({ preferences: { shellThemeId: "dark" } }));
const terminalPreferencesPut = vi.fn(async () => ({ preferences: { shellThemeId: "dark" } }));

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: ({
    sessionName,
    active,
  }: {
    sessionName: string;
    active?: boolean;
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
        data-theme-mode={themeMode}
        data-terminal-theme-id={terminalThemeId}
      >
        Terminal {sessionName}
      </div>
    );
  },
}));

function renderTab(active = true) {
  return render(
    <Tooltip.Provider>
      <TerminalsTab active={active} />
    </Tooltip.Provider>,
  );
}

describe("TerminalsTab", () => {
  beforeEach(() => {
    terminalMounts.clear();
    terminalPreferencesGet.mockClear();
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

  it("places a compact shell theme icon beside the session status pill", () => {
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
    const headerActions = header.querySelector("[data-terminal-header-actions]");
    const themeButton = screen.getByRole("button", { name: "Shell theme" });
    expect(headerActions?.contains(active)).toBe(true);
    expect(headerActions?.contains(themeButton)).toBe(true);
    expect(headerActions?.classList.contains("no-drag")).toBe(true);
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

    expect(useTabs.getState().recentViews).toEqual([]);
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

  it("keeps the OS View sidebar delete action accessible", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();

    expect(screen.getByRole("button", { name: "Delete matrix-main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions for matrix-main" })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("menuitem", { name: /Codex/ }));
    await waitFor(() => expect(createShell).toHaveBeenCalledWith(useConnection.getState().api, {
      cmd: "codex",
      agent: "codex",
    }));
  });

  it("shows the running agent and its current activity in each session row", () => {
    useShellSessions.setState({
      sessions: [{
        name: "matrix-main",
        status: "active",
        agent: "codex",
        model: "gpt-5.4",
        strength: "high",
        lastAction: "Editing terminal sidebar",
      }],
    });

    renderTab();

    const row = screen.getByRole("button", { name: "Open matrix-main" });
    expect(row.textContent).toContain("Codex");
    expect(row.textContent).toContain("gpt-5.4");
    expect(row.textContent).toContain("high");
    expect(row.textContent).toContain("Editing terminal sidebar");
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

  it("renders canonical active, waiting, and closed lifecycle badges with relative activity", () => {
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
    expect(document.querySelector('[data-terminal-session-status="active"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-terminal-session-status="inactive"]')).toHaveLength(2);
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
    useTabs.getState().recordRecentTerminal("matrix-main", "matrix-main");

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Delete matrix-main" }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("Delete matrix-main?")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.top).toBe("50%");
    expect(dialog.style.transform).toBe("translate(-50%, -50%)");

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main"));
    await waitFor(() => expect(useTabs.getState().recentViews).toEqual([]));
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
    fireEvent.click(screen.getByRole("button", { name: "Delete matrix-delete" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home]));
    expect(useTabs.getState().activeTabId).toBe(home);
  });

  it("removes stale terminal Recents after an authoritative session load", async () => {
    useTabs.getState().recordRecentTerminal("matrix-live", "matrix-live");
    useTabs.getState().recordRecentTerminal("matrix-deleted", "matrix-deleted");
    useShellSessions.setState({
      sessions: [{ name: "matrix-live", status: "active", placement: "active" }],
      loading: false,
      error: null,
      loadSequence: 1,
      authoritativeRevision: 1,
    });

    renderTab();

    await waitFor(() => expect(useTabs.getState().recentViews.map((recent) => recent.id))
      .toEqual(["matrix-live"]));
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
