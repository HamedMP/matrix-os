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

vi.mock("@matrix-os/ui", async () => ({
  ...await import("../../packages/ui/src/agents-providers/provider-workflow-client.js"),
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
      userId: "user_alice",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "vm-2",
      authGeneration: 7,
      api: { forRuntime: vi.fn(() => pinned) } as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useConnection.setState(useConnection.getInitialState(), true);
  });

  it.each(["runtime", "owner", "user ID", "credential", "unmount"])(
    "cancels checkout and rejects a late URL after %s changes in the rendered caller",
    async (change) => {
      let release!: (value: unknown) => void;
      let requestSignal!: AbortSignal;
      const post = vi.fn((_path, _body, options) => {
        requestSignal = options.signal;
        return new Promise((resolve) => { release = resolve; });
      });
      const openExternal = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("operator", { invoke: openExternal });
      useConnection.setState({ api: { post, forRuntime: vi.fn(() => ({})) } as never });
      const view = render(<AgentsProvidersAdapter />);
      const props = mocks.view.mock.calls.at(-1)![0] as unknown as {
        onAddCredit: (source: string, packageId: "usd_5", requestId: string) => Promise<void>;
      };
      let pending!: Promise<boolean>;
      act(() => {
        pending = props.onAddCredit("matrix", "usd_5", crypto.randomUUID()).then(() => true, () => false);
      });
      if (change === "unmount") view.unmount();
      else act(() => useConnection.setState(change === "runtime" ? { runtimeSlot: "other" }
        : change === "owner" ? { handle: "bob" }
        : change === "user ID" ? { userId: "user_other" } : { authGeneration: 8 }));
      release({ url: "https://checkout.stripe.com/c/pay/cs_previous" });
      let completed!: boolean;
      await act(async () => { completed = await pending; });
      expect({ completed, aborted: requestSignal.aborted, opens: openExternal.mock.calls.length })
        .toEqual({ completed: false, aborted: true, opens: 0 });
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it("does not start checkout from a callback whose rendered scope has left", async () => {
    const post = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_stale" });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("operator", { invoke: openExternal });
    useConnection.setState({ api: { post, forRuntime: vi.fn(() => ({})) } as never });
    const view = render(<AgentsProvidersAdapter />);
    const props = mocks.view.mock.calls.at(-1)![0] as unknown as {
      onAddCredit: (source: string, packageId: "usd_5", requestId: string) => Promise<void>;
    };
    view.unmount();
    await expect(props.onAddCredit("matrix", "usd_5", crypto.randomUUID())).rejects.toThrow("Checkout unavailable");
    expect(post).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens checkout once while the rendered identity and lifetime are current", async () => {
    const post = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_current" });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("operator", { invoke: openExternal });
    useConnection.setState({ api: { post, forRuntime: vi.fn(() => ({})) } as never });
    render(<React.StrictMode><AgentsProvidersAdapter /></React.StrictMode>);
    const props = mocks.view.mock.calls.at(-1)![0] as unknown as {
      onAddCredit: (source: string, packageId: "usd_5", requestId: string) => Promise<void>;
    };
    await act(() => props.onAddCredit("matrix", "usd_5", crypto.randomUUID()));
    expect(post).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("shell:open-external", {
      url: "https://checkout.stripe.com/c/pay/cs_current",
    });
  });

  it("rechecks the live identity immediately before opening, even before scope cleanup", async () => {
    let signalWasAborted = true;
    const post = vi.fn(async (_path, _body, options) => ({
      get url() {
        signalWasAborted = options.signal.aborted;
        useConnection.setState({ authGeneration: 8 });
        return "https://checkout.stripe.com/c/pay/cs_previous";
      },
    }));
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("operator", { invoke: openExternal });
    useConnection.setState({ api: { post, forRuntime: vi.fn(() => ({})) } as never });
    render(<AgentsProvidersAdapter />);
    const props = mocks.view.mock.calls.at(-1)![0] as unknown as {
      onAddCredit: (source: string, packageId: "usd_5", requestId: string) => Promise<void>;
    };
    let completed!: boolean;
    await act(async () => {
      completed = await props.onAddCredit("matrix", "usd_5", crypto.randomUUID()).then(() => true, () => false);
    });
    expect(signalWasAborted).toBe(false);
    expect(completed).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("renders the shared view with an owner-, runtime-, and credential-scoped controller", () => {
    render(<AgentsProvidersAdapter />);

    expect(screen.getByTestId("shared-agents-providers-view").textContent).toBe("ready");
    expect(mocks.controller).toHaveBeenCalledWith(expect.objectContaining({
      identityKey: "signed-in|alice|user_alice|https://app.matrix-os.com|vm-2|7",
      transport: expect.objectContaining({
        getSnapshot: expect.any(Function),
        mutate: expect.any(Function),
      }),
    }));
    expect(useConnection.getState().api?.forRuntime).toHaveBeenCalledWith("vm-2");
  });

  it("invalidates Chat only from accepted Settings callbacks for the current scope", () => {
    render(<AgentsProvidersAdapter />);
    const accepted = mocks.controller.mock.calls.at(-1)![0].onCatalogChanged;
    expect(useConnection.getState().providerCatalogGeneration).toBe(0);
    act(() => accepted());
    expect(useConnection.getState().providerCatalogGeneration).toBe(1);
    act(() => useConnection.setState({ authGeneration: 8 }));
    act(() => accepted());
    expect(useConnection.getState().providerCatalogGeneration).toBe(1);
    const current = mocks.controller.mock.calls.at(-1)![0].onCatalogChanged;
    act(() => current());
    expect(useConnection.getState().providerCatalogGeneration).toBe(2);
    act(() => useConnection.setState({ runtimeSlot: "other" }));
    act(() => current());
    expect(useConnection.getState().providerCatalogGeneration).toBe(2);
    const previousUser = mocks.controller.mock.calls.at(-1)![0].onCatalogChanged;
    act(() => useConnection.setState({ userId: "user_other" }));
    act(() => previousUser());
    expect(useConnection.getState().providerCatalogGeneration).toBe(2);
    const currentUser = mocks.controller.mock.calls.at(-1)![0].onCatalogChanged;
    act(() => currentUser());
    expect(useConnection.getState().providerCatalogGeneration).toBe(3);
  });

  it.each([
    { boundary: "trusted credential generation", change: { authGeneration: 8 },
      identityKey: "signed-in|alice|user_alice|https://app.matrix-os.com|vm-2|8" },
    { boundary: "owner user ID with the same handle", change: { userId: "user_other" },
      identityKey: "signed-in|alice|user_other|https://app.matrix-os.com|vm-2|7" },
  ])("changes controller identity when the $boundary changes", ({ change, identityKey }) => {
    render(<AgentsProvidersAdapter />);
    act(() => useConnection.setState(change));

    expect(mocks.controller).toHaveBeenLastCalledWith(expect.objectContaining({
      identityKey,
    }));
  });

  it("rejects a connection refresh result after trusted runtime generation changes", async () => {
    let release!: (snapshot: unknown) => void;
    const refreshForConnection = vi.fn(() => new Promise((done) => { release = done; }));
    mocks.controller.mockReturnValue({ ...mocks.controller.mock.results[0]?.value,
      snapshot: { revision: 1 }, refreshForConnection, onSelectHarness: vi.fn(), refresh: vi.fn(), mutate: vi.fn() });
    render(<AgentsProvidersAdapter />);
    const props = mocks.view.mock.calls.at(-1)![0] as unknown as { onRefreshForConnection: () => Promise<unknown> };
    const pending = props.onRefreshForConnection();
    act(() => useConnection.setState({ authGeneration: 8 }));
    release({ revision: 2 });
    expect(await pending).toBeNull();
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
