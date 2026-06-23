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

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div>Terminal {sessionName}</div>,
}));

function renderTab() {
  return render(
    <Tooltip.Provider>
      <TerminalsTab />
    </Tooltip.Provider>,
  );
}

describe("TerminalsTab", () => {
  beforeEach(() => {
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
      load: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ name: "matrix-created", status: "active" }),
      deleteSession: vi.fn().mockResolvedValue(true),
      rename: vi.fn().mockResolvedValue(true),
      reorder: vi.fn().mockResolvedValue(true),
      patchUiState: vi.fn().mockResolvedValue(true),
    });
    useTabs.setState({
      tabs: [],
      activeTabId: null,
      openTab: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders Active and Background groups from shell placement with open-tab fallback", () => {
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

    const activeGroup = screen.getByTestId("shell-group-active");
    const backgroundGroup = screen.getByTestId("shell-group-background");
    expect(activeGroup.textContent).toContain("matrix-active");
    expect(activeGroup.textContent).toContain("matrix-open");
    expect(backgroundGroup.textContent).toContain("matrix-bg");
    expect(screen.queryByText("Workspace Only")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /rename matrix-main/i }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "Bad Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/use lowercase letters, numbers, and hyphens/i)).toBeTruthy();
    expect(rename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(rename).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", "matrix-dev"));
  });

  it("requires confirmation before deleting a shell", async () => {
    const deleteSession = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
      deleteSession,
    });

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /delete matrix-main/i }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("Delete matrix-main?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main"));
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

  it("opens selected shell sessions in a native terminal tab", async () => {
    const openTab = vi.fn();
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active" }],
    });
    useTabs.setState({ openTab });

    renderTab();

    await screen.findByText("Terminal matrix-main");
    fireEvent.click(screen.getByRole("button", { name: /open matrix-main/i }));

    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "matrix-main",
      title: "matrix-main",
    });
  });

  it("moves shells between active and background via ui-state patches", async () => {
    const patchUiState = vi.fn().mockResolvedValue(true);
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active", latestSeq: 8 }],
      patchUiState,
    });

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /move matrix-main to background/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /make matrix-main active/i }));

    await waitFor(() =>
      expect(patchUiState).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main", {
        placement: "active",
        lastSeenSeq: 8,
      }),
    );
  });
});
