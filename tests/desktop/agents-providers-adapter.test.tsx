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
import * as providerActions from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter";

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
    vi.restoreAllMocks();
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

  it.each(["open_terminal", "open_browser"])("opens a new %s login action once and never on render", async (kind) => {
    const terminal = vi.spyOn(providerActions, "openExistingProviderTerminalSession").mockResolvedValue(true);
    const browser = vi.spyOn(providerActions, "openProviderAuthorizationPath").mockResolvedValue(true);
    const action = kind === "open_terminal"
      ? { kind, terminalSessionId: "provider-login" }
      : { kind, authorizationPath: "/api/ai/providers/login-attempts/attempt-1/authorize" };
    const mutate = vi.fn(async (_intent, options) => {
      options.onLoginAction(action);
      return true;
    });
    mocks.controller.mockReturnValue({ ...mocks.controller(), mutate });
    render(<AgentsProvidersAdapter />);
    expect(terminal).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    const props = mocks.view.mock.calls.at(-1)![0] as unknown as { onMutate: (intent: unknown) => Promise<boolean> };
    await act(() => props.onMutate({ type: "start_login", harnessInstanceId: "harness_codex", accountId: null, method: "terminal" }));
    expect(kind === "open_terminal" ? terminal : browser).toHaveBeenCalledTimes(1);
    expect(kind === "open_terminal" ? browser : terminal).not.toHaveBeenCalled();
  });

  it("drops delayed sign-in actions after the credential generation changes", async () => {
    const terminal = vi.spyOn(providerActions, "openExistingProviderTerminalSession").mockResolvedValue(true);
    let deliver: (action: unknown) => void = () => {};
    const mutate = vi.fn(async (_intent, options) => { deliver = options.onLoginAction; return true; });
    mocks.controller.mockReturnValue({ ...mocks.controller(), mutate });
    render(<AgentsProvidersAdapter />);
    const props = mocks.view.mock.calls.at(-1)![0] as unknown as { onMutate: (intent: unknown) => Promise<boolean> };
    await act(() => props.onMutate({ type: "start_login", harnessInstanceId: "harness_codex", accountId: null, method: "terminal" }));
    act(() => useConnection.setState({ authGeneration: 8 }));
    deliver({ kind: "open_terminal", terminalSessionId: "provider-login" });
    expect(terminal).not.toHaveBeenCalled();
  });
});
