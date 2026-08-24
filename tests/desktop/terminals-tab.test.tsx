// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalsTab from "../../desktop/src/renderer/src/features/terminal/TerminalsTab";
import NavigationHeader from "../../desktop/src/renderer/src/features/mission-control/NavigationHeader";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useTerminalAppearance } from "../../desktop/src/renderer/src/stores/terminal-appearance";

const terminalMounts = vi.hoisted(() => new Map<string, number>());

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: ({
    sessionName,
    active,
    themeMode,
  }: {
    sessionName: string;
    active?: boolean;
    themeMode?: "dark" | "light";
  }) => {
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

function openShellActions(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${name}` }), {
    button: 0,
    ctrlKey: false,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("TerminalsTab", () => {
  beforeEach(() => {
    terminalMounts.clear();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {} as never,
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
    useTerminalAppearance.setState({
      ...useTerminalAppearance.getInitialState(),
      mode: "dark",
      hydrated: true,
      load: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn((mode: "dark" | "light") => {
        useTerminalAppearance.setState({ mode });
      }),
    }, true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders only canonical shell sessions while preserving active and background placement actions", () => {
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

    expect(screen.getByTestId("shell-card-matrix-active")).toBeTruthy();
    expect(screen.getByTestId("shell-card-matrix-open")).toBeTruthy();
    expect(screen.getByTestId("shell-card-matrix-bg")).toBeTruthy();
    openShellActions("matrix-active");
    expect(screen.getByRole("menuitem", { name: "Move to background" })).toBeTruthy();
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

  it("defaults the Terminal session to dark and switches only its local surface to light", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));

    expect(screen.getByRole("group", { name: "Terminal theme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use dark Terminal theme" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-theme-mode"))
      .toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Use light Terminal theme" }));

    expect(screen.getByRole("button", { name: "Use light Terminal theme" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-theme-mode"))
      .toBe("light");
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
    expect(screen.getByText("matrix-main").className).toContain("font-medium");
    expect(screen.queryByTestId("terminal-view-matrix-main")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));

    expect(screen.queryByRole("navigation", { name: "Terminal breadcrumb" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to terminal sessions" })).toBeNull();
    expect(screen.getByRole("tablist", { name: "Terminal app tabs" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Terminal sessions" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "matrix-main" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "matrix-main" })).toBeTruthy();
    expect(screen.getByText(/Started at .*main computer/)).toBeTruthy();
    expect(screen.getByTestId("terminal-view-matrix-main").getAttribute("data-active")).toBe("true");
    expect(terminalMounts.get("matrix-main")).toBe(1);
  });

  it("returns from a selected Terminal session through the internal Sessions tab", async () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const workspaceTabId = useTabs.getState().openTab({
      kind: "terminals",
      title: "Terminal",
      closable: false,
    });
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    render(
      <Tooltip.Provider>
        <NavigationHeader />
        <TerminalsTab />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "matrix-main" })).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "Terminal sessions" }));

    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    expect(useTabs.getState().activeTabId).toBe(workspaceTabId);
  });

  it("keeps the shared breadcrumb at the Terminal app while internal tabs change", async () => {
    useTabs.setState(useTabs.getInitialState(), true);
    const workspaceTabId = useTabs.getState().openTab({
      kind: "terminals",
      title: "Terminal",
      closable: false,
    });
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    render(
      <Tooltip.Provider>
        <NavigationHeader />
        <TerminalsTab />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "matrix-main" })).toBeTruthy());

    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Terminal");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal sessions" }));

    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    expect(useTabs.getState().activeTabId).toBe(workspaceTabId);
  });

  it("keeps the Terminal app identity while selecting an internal session tab", async () => {
    useTabs.setState(useTabs.getInitialState(), true);
    const workspaceTabId = useTabs.getState().openTab({
      kind: "terminals",
      title: "Terminal",
      closable: false,
    });
    useShellSessions.setState({
      sessions: [{ name: "clever-comet", status: "active", placement: "active" }],
    });

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open clever-comet" }));

    await waitFor(() => {
      expect(useTabs.getState().tabs.find((tab) => tab.id === workspaceTabId)?.title)
        .toBe("Terminal");
    });
    expect(screen.getByRole("tab", { name: "clever-comet" }).getAttribute("aria-selected"))
      .toBe("true");

    act(() => useTabs.getState().requestTerminalOverview());
    await waitFor(() => {
      expect(useTabs.getState().tabs.find((tab) => tab.id === workspaceTabId)?.title)
        .toBe("Terminal");
    });
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

  it("retires a missing Recent after canonical loading completes so a reused name does not open", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().requestTerminalSession("matrix-deleted");
    useShellSessions.setState({
      sessions: [],
      loading: false,
      error: null,
      loadSequence: 1,
      authoritativeRevision: 1,
    });

    renderTab();

    expect(useTabs.getState().terminalSessionRequest).toBeNull();

    act(() => {
      useShellSessions.setState({
        sessions: [{ name: "matrix-deleted", status: "active", placement: "active" }],
      });
    });

    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    expect(screen.queryByTestId("terminal-view-matrix-deleted")).toBeNull();
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

  it("uses the Figma list toolbar and reveals a bounded search-empty state", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();

    const heading = screen.getByRole("heading", { name: "Terminal" });
    expect(heading.className).toContain("text-[36px]");
    expect(heading.closest("[data-terminal-overview]")?.className).toContain("max-w-[1022px]");
    expect(screen.getByRole("list", { name: "Terminal sessions" }).parentElement?.className)
      .not.toContain("rounded-lg");
    expect(screen.queryByRole("button", { name: "Select terminal sessions" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search terminal sessions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search terminal sessions" }));
    const input = screen.getByRole("textbox", { name: "Search terminal sessions" });
    fireEvent.change(input, { target: { value: "not-a-session" } });

    expect(screen.getByRole("heading", { name: "No matching sessions" })).toBeTruthy();
    expect(screen.getByText("Try a different search term.")).toBeTruthy();
  });

  it("keeps secondary row actions in an accessible overflow menu", () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });

    renderTab();

    expect(screen.queryByRole("button", { name: "Rename matrix-main" })).toBeNull();
    openShellActions("matrix-main");

    const menu = screen.getByRole("menu", { name: "More actions for matrix-main" });
    expect(menu).toBeTruthy();
    expect((menu as HTMLElement).style.zIndex).toBe("100");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy attach command" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
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

    expect(screen.getByTestId("shell-card-matrix-active").textContent).toContain("Active");
    expect(screen.getByTestId("shell-card-matrix-active").textContent).toContain("2 minutes ago");
    expect(screen.getByTestId("shell-card-matrix-waiting").textContent).toContain("Waiting");
    expect(screen.getByTestId("shell-card-matrix-closed").textContent).toContain("Closed");
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

    fireEvent.click(screen.getByRole("button", { name: "New shell" }));

    await waitFor(() => expect(createShell).toHaveBeenCalledWith(useConnection.getState().api));
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("validates rename input and calls shell rename", async () => {
    const rename = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      rename,
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const row = screen.getByTestId("shell-card-matrix-main");
    expect(row.className).toContain("min-h-16");
    expect(screen.queryByRole("button", { name: "Open matrix-main" })).toBeNull();
    const input = screen.getByRole("textbox", { name: /shell name/i });
    expect(input.closest("[data-shell-rename-editor]")?.className).not.toContain("absolute");
    fireEvent.change(input, { target: { value: "Bad Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/use lowercase letters, numbers, and hyphens/i)).toBeTruthy();
    expect(rename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(rename).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", "matrix-dev"));
  });

  it("keeps a newer shell selection when rename finishes after the user changes selection", async () => {
    const renameResult = deferred<boolean>();
    const rename = vi.fn().mockReturnValue(renameResult.promise);
    useShellSessions.setState({
      sessions: [
        { name: "matrix-main", status: "active", placement: "active" },
        { name: "matrix-other", status: "active", placement: "active" },
      ],
      rename,
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText("matrix-other"));

    await act(async () => {
      renameResult.resolve(true);
      await renameResult.promise;
    });

    await waitFor(() => expect(screen.getByText("Terminal matrix-other")).toBeTruthy());
  });

  it("updates already-open terminal tabs after shell rename", async () => {
    const rename = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      rename,
    });
    useTabs.setState({
      tabs: [{ id: "tab-main", kind: "terminal", title: "matrix-main", sessionName: "matrix-main", closable: true }],
      activeTabId: "tab-main",
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(rename).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", "matrix-dev"));
    expect(useTabs.getState().tabs[0]).toMatchObject({
      title: "matrix-dev",
      sessionName: "matrix-dev",
    });
  });

  it("keeps the optimistically renamed row busy while rename is pending", async () => {
    const renameResult = deferred<boolean>();
    const rename = vi.fn((_api, _name: string, nextName: string) => {
      useShellSessions.setState({
        sessions: [{ name: nextName, status: "active", placement: "active" }],
      });
      return renameResult.promise;
    });
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      rename,
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("shell-card-matrix-dev")).toBeTruthy());
    expect((screen.getByRole("button", { name: /open matrix-dev/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /more actions for matrix-dev/i }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      renameResult.resolve(true);
      await renameResult.promise;
    });
  });

  it("keeps a newer rename editor open when another shell rename finishes", async () => {
    const renameResult = deferred<boolean>();
    const rename = vi.fn().mockReturnValue(renameResult.promise);
    useShellSessions.setState({
      sessions: [
        { name: "matrix-main", status: "active", placement: "active" },
        { name: "matrix-other", status: "active", placement: "active" },
      ],
      rename,
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    openShellActions("matrix-other");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    await act(async () => {
      renameResult.resolve(true);
      await renameResult.promise;
    });

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: /shell name/i }) as HTMLInputElement).value).toBe("matrix-other");
    });
  });

  it("requires confirmation before deleting a shell", async () => {
    const deleteSession = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      deleteSession,
    });
    useTabs.getState().recordRecentTerminal("matrix-main", "matrix-main");

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
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
    openShellActions("matrix-delete");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
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

  it("keeps a newer shell selection when delete finishes after the user changes selection", async () => {
    const deleteResult = deferred<boolean>();
    const deleteSession = vi.fn().mockReturnValue(deleteResult.promise);
    useShellSessions.setState({
      sessions: [
        { name: "matrix-main", status: "active", placement: "active" },
        { name: "matrix-other", status: "active", placement: "active" },
        { name: "matrix-third", status: "active", placement: "active" },
      ],
      deleteSession,
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByText("matrix-third"));

    await act(async () => {
      deleteResult.resolve(true);
      await deleteResult.promise;
    });

    await waitFor(() => expect(screen.getByText("Terminal matrix-third")).toBeTruthy());
  });

  it("drag-reorders shell cards within the same group", async () => {
    const reorder = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [
        { name: "matrix-one", status: "active", placement: "active" },
        { name: "matrix-two", status: "active", placement: "active" },
      ],
      reorder,
    });

    renderTab();

    fireEvent.dragStart(screen.getByLabelText("Drag matrix-one"));
    fireEvent.dragEnter(screen.getByTestId("shell-card-matrix-two"));
    fireEvent.drop(screen.getByTestId("shell-card-matrix-two"));

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(useConnection.getState().api, "matrix-one", "matrix-two"));
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

  it("opens a canonical shell session in an internal Terminal app tab from overflow", async () => {
    const openTab = vi.fn();
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });
    useTabs.setState({ openTab });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Terminal tab" }));

    expect(openTab).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "matrix-main" }).getAttribute("aria-selected"))
      .toBe("true");
  });

  it("moves shells between active and background via ui-state patches", async () => {
    const patchUiState = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active", latestSeq: 8 }],
      patchUiState,
    });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to background" }));

    await waitFor(() =>
      expect(patchUiState).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", {
        placement: "background",
      }),
    );

    act(() => {
      useShellSessions.setState({
        sessions: [{ name: "matrix-main", status: "active", placement: "background", latestSeq: 8 }],
      });
    });

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Make active" }));

    await waitFor(() =>
      expect(patchUiState).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", {
        placement: "active",
        lastSeenSeq: 8,
      }),
    );
    expect(patchUiState).toHaveBeenCalledTimes(2);
  });

  it("allows other shell actions while one shell operation is busy", async () => {
    const firstMove = deferred<boolean>();
    const patchUiState = vi.fn((_api, name: string) => (name === "matrix-one" ? firstMove.promise : Promise.resolve(true)));
    const deleteSession = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [
        { name: "matrix-one", status: "active", placement: "active" },
        { name: "matrix-two", status: "active", placement: "active" },
        { name: "matrix-three", status: "active", placement: "active" },
      ],
      patchUiState,
      deleteSession,
    });

    renderTab();

    openShellActions("matrix-one");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to background" }));
    openShellActions("matrix-two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to background" }));
    openShellActions("matrix-three");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() =>
      expect(patchUiState).toHaveBeenCalledWith(useConnection.getState().api, "matrix-two", {
        placement: "background",
      }),
    );
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(useConnection.getState().api, "matrix-three"));

    await act(async () => {
      firstMove.resolve(true);
      await firstMove.promise;
    });
  });

  it("does not open a native terminal tab when making a shell active fails", async () => {
    const openTab = vi.fn();
    const patchUiState = vi.fn().mockResolvedValue(false);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "background", latestSeq: 8 }],
      patchUiState,
    });
    useTabs.setState({ openTab });

    renderTab();

    openShellActions("matrix-main");
    fireEvent.click(screen.getByRole("menuitem", { name: "Make active" }));

    await waitFor(() =>
      expect(patchUiState).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", {
        placement: "active",
        lastSeenSeq: 8,
      }),
    );
    expect(openTab).not.toHaveBeenCalled();
    expect(await screen.findByText("Could not update shell")).toBeTruthy();
  });
});
