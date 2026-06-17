// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalsTab from "../../desktop/src/renderer/src/features/terminal/TerminalsTab";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: ({ sessionName }: { sessionName: string }) => <div>Terminal {sessionName}</div>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
      sessions: [],
      error: null,
      creating: false,
      load: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(true),
      restart: vi.fn().mockResolvedValue(null),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("prevents duplicate session creates while one is in flight", async () => {
    let resolveCreate: ((value: { attachName: string; name: string; status: "active" }) => void) | null = null;
    const create = vi.fn(
      () =>
        new Promise<{ attachName: string; name: string; status: "active" }>((resolve) => {
          useSessions.setState({ creating: true });
          resolveCreate = (value) => {
            useSessions.setState({ creating: false });
            resolve(value);
          };
        }),
    );
    useSessions.setState({ create });

    render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    const button = screen.getAllByRole("button", { name: /new session/i })[0]!;
    fireEvent.click(button);
    const starting = screen.getByRole("button", { name: /starting/i }) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    fireEvent.click(starting);

    expect(create).toHaveBeenCalledOnce();

    await act(async () => {
      resolveCreate?.({ attachName: "main", name: "main", status: "active" });
      await Promise.resolve();
    });
    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: /new session/i }) as HTMLButtonElement[];
      expect(buttons.some((nextButton) => !nextButton.disabled)).toBe(true);
    });
  });

  it("shows loading and load errors instead of the empty session state", async () => {
    useSessions.setState({ loading: true, error: null, sessions: [] });

    const { rerender } = render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    expect(screen.getByText("Loading sessions...")).toBeTruthy();
    expect(screen.queryByText("No sessions on your computer yet.")).toBeNull();

    act(() => {
      useSessions.setState({ loading: false, error: "offline", sessions: [] });
    });
    rerender(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    expect(screen.getByText("Can't reach Matrix OS. Check your connection.")).toBeTruthy();
    expect(screen.queryByText("No sessions on your computer yet.")).toBeNull();
  });

  it("surfaces session creation failures", async () => {
    const create = vi.fn(async () => {
      useSessions.setState({ error: "server" });
      return null;
    });
    useSessions.setState({ create });

    render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /new session/i })[0]!);

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
  });

  it("selects a remaining session when the selected session disappears", async () => {
    useSessions.setState({
      sessions: [
        { attachName: "main", name: "main", status: "active", source: "workspace" },
        { attachName: "next", name: "next", status: "active", source: "workspace" },
      ],
    });

    render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    await screen.findByText("Terminal main");

    act(() => {
      useSessions.setState({
        sessions: [{ attachName: "next", name: "next", status: "active", source: "workspace" }],
      });
    });

    await screen.findByText("Terminal next");
    expect(screen.queryByText("Terminal main")).toBeNull();
  });

  it("disables restart while a kill operation is in flight", async () => {
    const killed = deferred<boolean>();
    const kill = vi.fn(() => killed.promise);
    const restart = vi.fn().mockResolvedValue({ attachName: "main", name: "main", status: "active" });
    useSessions.setState({
      sessions: [{ attachName: "main", name: "main", status: "exited", source: "workspace" }],
      kill,
      restart,
    });

    render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /kill session/i }));

    const restartButton = await screen.findByRole("button", { name: /restart session/i });
    expect((restartButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(restartButton);
    expect(restart).not.toHaveBeenCalled();

    await act(async () => {
      killed.resolve(true);
      await Promise.resolve();
    });
  });

  it("disables kill while a session is being created or restarted", () => {
    const kill = vi.fn().mockResolvedValue(true);
    useSessions.setState({
      sessions: [{ attachName: "main", name: "main", status: "active" }],
      creating: true,
      kill,
    });

    render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    const killButton = screen.getByRole("button", { name: /kill session/i }) as HTMLButtonElement;
    expect(killButton.disabled).toBe(true);
    fireEvent.click(killButton);
    expect(kill).not.toHaveBeenCalled();
  });

  it("surfaces restart failures", async () => {
    const restart = vi.fn().mockResolvedValue(null);
    useSessions.setState({
      sessions: [{ attachName: "main", name: "main", status: "exited" }],
      restart,
    });

    render(
      <Tooltip.Provider>
        <TerminalsTab />
      </Tooltip.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /restart session/i }));

    await screen.findByText(/restart failed/i);
    expect(restart).toHaveBeenCalledWith(expect.any(Object), "main");
  });
});
