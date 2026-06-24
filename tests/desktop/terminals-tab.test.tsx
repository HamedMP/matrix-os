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

    fireEvent.click(screen.getByRole("button", { name: /rename matrix-main/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /rename matrix-main/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /rename matrix-main/i }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("shell-card-matrix-dev")).toBeTruthy());
    expect((screen.getByRole("button", { name: /open matrix-dev/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /move matrix-dev to background/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /rename matrix-dev/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /delete matrix-dev/i }) as HTMLButtonElement).disabled).toBe(true);

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

    fireEvent.click(screen.getByRole("button", { name: /rename matrix-main/i }));
    const input = screen.getByRole("textbox", { name: /shell name/i });
    fireEvent.change(input, { target: { value: "matrix-dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /rename matrix-other/i }));

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

    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /delete matrix-main/i }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("Delete matrix-main?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(useConnection.getState().api, "matrix-main"));
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

    fireEvent.click(screen.getByRole("button", { name: /delete matrix-main/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /move matrix-one to background/i }));
    fireEvent.click(screen.getByRole("button", { name: /move matrix-two to background/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete matrix-three/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /make matrix-main active/i }));

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
