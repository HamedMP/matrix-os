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
      load: vi.fn().mockResolvedValue(undefined),
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
          resolveCreate = resolve;
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
    fireEvent.click(screen.getByRole("button", { name: /creating/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));

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
});
