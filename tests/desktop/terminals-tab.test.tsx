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
      creating: false,
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
});
