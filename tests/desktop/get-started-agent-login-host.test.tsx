// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const mocks = vi.hoisted(() => ({ controller: vi.fn() }));

vi.mock("@matrix-os/ui", async () => ({
  ...await import("../../packages/ui/src/agents-providers/provider-workflow-client.js"),
  useProviderSettingsController: mocks.controller,
}));

import { DesktopGetStartedAgentLogin } from "../../desktop/src/renderer/src/features/get-started/DesktopGetStartedAgentLogin";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.controller.mockReset();
  useConnection.setState(useConnection.getInitialState(), true);
});

describe("Electron Get started coding agents host", () => {
  it("points to Settings until this window is signed in to a computer", () => {
    const children = vi.fn(() => null);
    render(<DesktopGetStartedAgentLogin>{children}</DesktopGetStartedAgentLogin>);
    expect(screen.getByText("You can sign in to Claude Code or Codex later in Settings > Agents & providers.")).toBeInTheDocument();
    expect(children).not.toHaveBeenCalled();
    expect(mocks.controller).not.toHaveBeenCalled();
  });

  it("builds one port for the whole screen from the signed-in computer's provider state", () => {
    mocks.controller.mockReturnValue({ snapshot: null, error: null, refresh: vi.fn() });
    const pinned = { get: vi.fn(), post: vi.fn() };
    const forRuntime = vi.fn(() => pinned);
    useConnection.setState({
      status: "signed-in", handle: "alice", userId: "user_alice", platformHost: "https://app.matrix-os.com",
      runtimeSlot: "vm-2", authGeneration: 7, api: { forRuntime } as never,
    });
    const children = vi.fn(() => <p>agents</p>);
    render(<DesktopGetStartedAgentLogin>{children}</DesktopGetStartedAgentLogin>);
    expect(screen.getByText("agents")).toBeInTheDocument();
    expect(mocks.controller).toHaveBeenCalledTimes(1);
    expect(forRuntime).toHaveBeenCalledWith("vm-2");
    expect(children).toHaveBeenLastCalledWith(expect.objectContaining({ snapshot: null, failed: false }));
  });
});
