// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../desktop/src/renderer/src/App";
import { useAppearance } from "../../desktop/src/renderer/src/stores/appearance";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useDesktopUpdate } from "../../desktop/src/renderer/src/stores/desktop-update";

vi.mock("../../desktop/src/renderer/src/features/signin/SignIn", () => ({
  default: () => <div>Signed out</div>,
}));
vi.mock("../../desktop/src/renderer/src/features/mission-control/MissionControl", () => ({
  default: () => <div>Mission Control</div>,
}));

describe("App desktop update experience", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps manual update feedback available while signed out", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    vi.stubGlobal("operator", {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "update:get-state") return { status: "disabled" };
        if (channel === "update:get-whats-new") return { release: null, shouldOpen: false };
        if (channel === "embed:suspend-all") return { ok: true };
        return { signedIn: false, platformHost: "", runtimeSlot: "primary", authGeneration: 0 };
      }),
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      }),
    });
    useConnection.setState({
      status: "signed-out",
      refresh: vi.fn(async () => undefined),
    });
    useAppearance.setState({ load: vi.fn(async () => undefined) });
    useDesktopUpdate.setState({
      snapshot: { status: "disabled" },
      release: null,
      whatsNewOpen: false,
      manualDialogOpen: false,
      installing: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(listeners.has("update:manual-check-requested")).toBe(true);
    });
    act(() => {
      listeners.get("update:manual-check-requested")?.({});
    });
    expect(await screen.findByRole("dialog", { name: "Software Update" })).toBeTruthy();
    expect(screen.getByText("Signed out")).toBeTruthy();
  });
});
