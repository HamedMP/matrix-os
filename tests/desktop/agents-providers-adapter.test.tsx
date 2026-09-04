// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const mocks = vi.hoisted(() => ({
  controller: vi.fn(),
  view: vi.fn((props: { snapshot: unknown }) => (
    <div data-testid="shared-agents-providers-view">{props.snapshot ? "ready" : "missing"}</div>
  )),
}));

vi.mock("@matrix-os/ui", () => ({
  AgentsProvidersView: mocks.view,
  useProviderSettingsController: mocks.controller,
}));

import AgentsProvidersAdapter from "../../desktop/src/renderer/src/features/settings/AgentsProvidersAdapter";

describe("desktop shared agents and providers adapter", () => {
  beforeEach(() => {
    mocks.controller.mockReset();
    mocks.view.mockClear();
    mocks.controller.mockReturnValue({
      snapshot: { revision: 1 },
      selectedHarnessId: "harness_codex",
      connectionAttempt: null,
      busy: false,
      error: null,
      onSelectHarness: vi.fn(),
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    const pinned = { get: vi.fn(), post: vi.fn() };
    useConnection.setState({
      status: "signed-in",
      handle: "alice",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "vm-2",
      authGeneration: 7,
      api: { forRuntime: vi.fn(() => pinned) } as never,
    });
  });

  afterEach(() => {
    cleanup();
    useConnection.setState(useConnection.getInitialState(), true);
  });

  it("renders the shared view with a runtime- and credential-scoped controller", () => {
    render(<AgentsProvidersAdapter />);

    expect(screen.getByTestId("shared-agents-providers-view").textContent).toBe("ready");
    expect(mocks.controller).toHaveBeenCalledWith(expect.objectContaining({
      identityKey: "signed-in|alice|https://app.matrix-os.com|vm-2|7",
      transport: expect.objectContaining({
        getSnapshot: expect.any(Function),
        mutate: expect.any(Function),
      }),
    }));
    expect(useConnection.getState().api?.forRuntime).toHaveBeenCalledWith("vm-2");
  });

  it("changes controller identity when the trusted credential generation changes", () => {
    render(<AgentsProvidersAdapter />);
    act(() => useConnection.setState({ authGeneration: 8 }));

    expect(mocks.controller).toHaveBeenLastCalledWith(expect.objectContaining({
      identityKey: "signed-in|alice|https://app.matrix-os.com|vm-2|8",
    }));
  });

  it("offers a safe retry when the initial provider snapshot cannot load", () => {
    const refresh = vi.fn();
    mocks.controller.mockReturnValue({
      snapshot: null,
      selectedHarnessId: null,
      connectionAttempt: null,
      busy: false,
      error: "unsafe upstream detail must not render",
      onSelectHarness: vi.fn(),
      refresh,
      mutate: vi.fn(),
    });
    render(<AgentsProvidersAdapter />);

    expect(screen.queryByText("unsafe upstream detail must not render")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry provider settings" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
