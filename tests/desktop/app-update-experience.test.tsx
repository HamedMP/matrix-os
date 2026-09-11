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

  it.each(["different-release", "incompatible", "unavailable"])("keeps the workspace usable without cloud update controls: %s", async (scenario) => {
    vi.stubGlobal("operator", {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "app:get-version") return { version: "0.1.0", source: { commit: "b".repeat(40), ancestors: ["a".repeat(40)] } };
        if (channel === "update:check") return { status: "up-to-date" };
        if (channel === "update:get-state") return { status: "disabled" };
        if (channel === "update:get-whats-new") return { release: null, shouldOpen: false };
        return { ok: true };
      }),
      on: vi.fn(() => () => undefined),
    });
    useAppearance.setState({ load: vi.fn(async () => undefined) });
    useConnection.setState({
      status: "signed-in",
      refresh: vi.fn(async () => undefined),
      api: { forRuntime() { return this; }, post: vi.fn(), get: vi.fn(async () => {
        if (scenario === "unavailable") throw new Error("HTTP 502");
        return { version: "v2026.09.09-1", build: { sha: "a".repeat(40) },
          runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: scenario === "incompatible" ? 2 : 1, maxDesktopProtocol: 3 } };
      }) } as never,
    });
    render(<App />);
    expect(screen.getByText("Mission Control")).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Update Matrix OS" })).toBeNull();
    expect(screen.queryByText("Cloud computer")).toBeNull();
    expect(useConnection.getState().api!.get).not.toHaveBeenCalled();
    expect(useConnection.getState().api!.post).not.toHaveBeenCalled();
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
