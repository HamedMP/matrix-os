// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ProviderHarnessInstance,
  ProviderWorkflowCapability,
} from "@matrix-os/contracts";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
afterEach(cleanup);
const harness = {
  id: "codex",
  harness: "codex",
  displayName: "Codex",
  installState: "installed",
  authState: "unauthenticated",
} as ProviderHarnessInstance;
const capability: ProviderWorkflowCapability = {
  harnessInstanceId: "codex",
  harness: "codex",
  displayName: "Codex",
  installState: "installed",
  loginMethods: ["device_code"],
  apiKeyProviders: ["openai"],
  install: false,
  uninstall: true,
  logs: true,
};
const client = (): ProviderWorkflowClient => ({
  capabilities: vi.fn().mockResolvedValue([capability]),
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  submitKey: vi
    .fn()
    .mockRejectedValue(new ProviderWorkflowClientError("rejected")),
  logs: vi.fn().mockResolvedValue({ entries: [] }),
});
it("keeps keys transient and presents safe rejection with retry", async () => {
  const api = client();
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  const input = screen.getByLabelText("Paste your OpenAI API key");
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, { target: { value: "sk-secret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The key could not be verified",
    ),
  );
  expect(document.body.textContent).not.toContain("sk-secret");
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.queryByLabelText("Paste your OpenAI API key"),
  ).not.toBeInTheDocument();
});
it("install uses actual operation and does not fabricate progress", async () => {
  const api = client();
  api.start = vi.fn().mockResolvedValue({
    id: "wf",
    harnessInstanceId: "codex",
    kind: "install",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: "tws_1:tt_1",
    deviceCode: null,
    authorizationUrl: null,
    safeFailure: null,
  });
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, installState: "missing" }}
      capability={{ ...capability, install: true }}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument(),
  );
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  expect(document.body.textContent).not.toContain("62%");
});
it("ignores a key verification that settles after its foreground scope closes", async () => {
  let settle: (() => void) | undefined;
  const api = client();
  api.submitKey = vi.fn(
    () =>
      new Promise<{ verified: true }>((resolve) => {
        settle = () => resolve({ verified: true });
      }),
  );
  const refresh = vi.fn();
  const result = render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  fireEvent.change(screen.getByLabelText("Paste your OpenAI API key"), {
    target: { value: "sk-secret-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  result.unmount();
  settle?.();
  await Promise.resolve();
  expect(refresh).not.toHaveBeenCalled();
});
it("disconnect requires explicit confirmation and keeps optional uninstall unchecked", async () => {
  const api = client();
  const disconnect = vi.fn().mockResolvedValue(true);
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, authState: "authenticated" }}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
      onDisconnect={disconnect}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(disconnect).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Your chats, projects and settings stay",
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[1]);
  await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  expect(api.start).not.toHaveBeenCalled();
});
it("resumes the same operation handle after an accordion reopens", async () => {
  const api = client();
  const operation = {
    id: "wf_saved",
    harnessInstanceId: "codex",
    kind: "login",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: null,
    deviceCode: "ABCD-EFGH",
    authorizationUrl: "https://auth.openai.com/codex/device",
    safeFailure: null,
  };
  api.get = vi.fn().mockResolvedValue(operation);
  api.cancel = vi.fn().mockResolvedValue({ ...operation, state: "cancelled" });
  const refresh = vi.fn();
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      operationId="wf_saved"
      onOperationId={vi.fn()}
      disabled={false}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={vi.fn()}
    />,
  );
  await screen.findByText("ABCD-EFGH");
  expect(api.get).toHaveBeenCalledWith("wf_saved", expect.any(AbortSignal));
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});
it("clears secret and transient form state when the client identity changes", async () => {
  const api = client();
  const other = client();
  const props = {
    harness,
    capability,
    disabled: false,
    onRefresh: vi.fn(),
    onOpenTerminal: vi.fn(),
    onOpenAuthorizationUrl: vi.fn(),
  };
  const result = render(<HarnessWorkflowPanel {...props} client={api} />);
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  fireEvent.change(screen.getByLabelText("Paste your OpenAI API key"), {
    target: { value: "sk-old-owner-secret" },
  });
  result.rerender(<HarnessWorkflowPanel {...props} client={other} />);
  expect(
    screen.queryByLabelText("Paste your OpenAI API key"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  expect(screen.getByLabelText("Paste your OpenAI API key")).toHaveValue("");
  expect(other.submitKey).not.toHaveBeenCalled();
});
it("contains a blocked sign-in popup as a safe actionable failure", async () => {
  const api = client();
  api.get = vi.fn().mockResolvedValue({
    id: "wf",
    harnessInstanceId: "codex",
    kind: "login",
    state: "running",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    terminalSessionId: null,
    deviceCode: "ABCD-EFGH",
    authorizationUrl: "https://auth.openai.com/codex/device",
    safeFailure: null,
  });
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      operationId="wf"
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenAuthorizationUrl={() => {
        throw new Error("private popup internals");
      }}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Open sign-in page" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The connection could not be updated",
    ),
  );
  expect(document.body.textContent).not.toContain("private popup internals");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
});
it("places the single change-account action inside the connected card slot", () => {
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, authState: "authenticated" }}
      capability={capability}
      client={client()}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
      renderConnection={(action) => (
        <article data-testid="connected-card">{action}</article>
      )}
    />,
  );
  const action = screen.getByRole("button", { name: "Change account" });
  expect(screen.getByTestId("connected-card")).toContainElement(action);
  expect(
    screen.getAllByRole("button", { name: "Change account" }),
  ).toHaveLength(1);
  fireEvent.click(action);
  expect(screen.getByRole("button", { name: /API key/ })).toBeInTheDocument();
});
it("reports uncertain key-save outcomes and refreshes without discarding masked input", async () => {
  const api = client();
  api.submitKey = vi.fn().mockRejectedValue(new ProviderWorkflowClientError());
  const refresh = vi.fn();
  render(
    <HarnessWorkflowPanel
      harness={harness}
      capability={capability}
      client={api}
      disabled={false}
      onRefresh={refresh}
      onOpenTerminal={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /API key/ }));
  const input = screen.getByLabelText("Paste your OpenAI API key");
  fireEvent.change(input, { target: { value: "sk-mask-retry" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not confirm the connection",
    ),
  );
  expect(refresh).toHaveBeenCalled();
  expect(input).toHaveValue("sk-mask-retry");
  expect(screen.getByRole("alert")).not.toHaveTextContent("verified");
});
it("reuses a pending start receipt key after a lost response", async () => {
  const api = client();
  api.start = vi.fn().mockRejectedValue(new ProviderWorkflowClientError());
  render(
    <HarnessWorkflowPanel
      harness={{ ...harness, installState: "missing" }}
      capability={{ ...capability, install: true }}
      client={api}
      disabled={false}
      onRefresh={vi.fn()}
      onOpenTerminal={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(api.start).mock.calls;
  expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
});

it("keeps device-code startup in Settings while waiting for the native code", async () => {
  const api = client();
  api.start = vi.fn().mockResolvedValue({ id: "wf", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_1:tt_1", deviceCode: null, authorizationUrl: null, safeFailure: null });
  const openTerminal = vi.fn();
  render(<HarnessWorkflowPanel harness={harness} capability={capability} client={api} disabled={false} onRefresh={vi.fn()} onOpenTerminal={openTerminal} />);
  fireEvent.click(screen.getByRole("button", { name: /ChatGPT account/ }));
  await screen.findByText(/Waiting for sign-in/);
  expect(openTerminal).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Continue in Terminal" })).not.toBeInTheDocument();
});

it("reuses the connected Codex account in Settings and refreshes immediate completion", async () => {
  const api = client();
  api.start = vi.fn().mockResolvedValue({ id: "wf", harnessInstanceId: "hermes", kind: "login", state: "succeeded", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null });
  const refresh = vi.fn(); const terminal = vi.fn();
  render(<HarnessWorkflowPanel harness={{...harness, id: "hermes", harness: "hermes", displayName: "Hermes"}} capability={{...capability, harnessInstanceId: "hermes", harness: "hermes", displayName: "Hermes", loginMethods: ["existing_codex"], apiKeyProviders: []}} client={api} disabled={false} onRefresh={refresh} onOpenTerminal={terminal} />);
  fireEvent.click(screen.getByRole("button", { name: /Use existing Codex account/ }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ harnessInstanceId: "hermes", method: "existing_codex" }), expect.any(AbortSignal));
  expect(terminal).not.toHaveBeenCalled();
});
it("finishes Claude browser sign-in inside Settings without exposing or retaining the code", async () => {
  const api = client(); api.submitCode = vi.fn().mockResolvedValue({accepted: true});
  api.get = vi.fn().mockResolvedValue({ id: "browser", harnessInstanceId: "claude", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture", safeFailure: null });
  const terminal = vi.fn();
  render(<HarnessWorkflowPanel harness={{...harness, id: "claude", harness: "claude", displayName: "Claude Code"}} capability={{...capability, harnessInstanceId: "claude", harness: "claude", loginMethods: ["browser"], apiKeyProviders: []}} client={api} operationId="browser" disabled={false} onRefresh={vi.fn()} onOpenTerminal={terminal} onOpenAuthorizationUrl={vi.fn()} />);
  const input = await screen.findByLabelText("Paste the sign-in code");
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, {target: {value: "fixture-code#fixture-state"}});
  fireEvent.click(screen.getByRole("button", {name: "Finish connecting"}));
  await waitFor(() => expect(api.submitCode).toHaveBeenCalledWith("browser", "fixture-code#fixture-state", expect.any(AbortSignal)));
  await waitFor(() => expect(input).toHaveValue(""));
  expect(document.body.textContent).not.toContain("fixture-code"); expect(terminal).not.toHaveBeenCalled();
});
it("offers explicit Connect for a saved Off account instead of silently restoring enablement on read", () => {
  const api = client();
  render(<HarnessWorkflowPanel harness={{...harness, authState: "authenticated", enabled: false}} capability={capability} client={api} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
  expect(screen.getByRole("button", {name: /ChatGPT account/})).toBeEnabled();
  expect(api.start).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", {name: "Disconnect"})).not.toBeInTheDocument();
});
it("shows account actions for a configured native connection without claiming remote readiness", () => {
  const api = client();
  render(<HarnessWorkflowPanel harness={{...harness, authState: "unknown", enabled: true, localObservation: {state: "present_unverified", checkedAt: "2026-10-02T00:00:00Z", staleAfter: "2026-10-02T00:10:00Z"}}} capability={capability} client={api} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} renderConnection={action => <article>Current account{action}</article>} />);
  expect(screen.getByText("Current account")).toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Change account"})).toBeInTheDocument();
  expect(screen.queryByText("Connect Codex with")).not.toBeInTheDocument();
  expect(api.start).not.toHaveBeenCalled();
});
it("omits unsupported Disconnect without a Matrix disconnection callback", () => {
  const api = client();
  render(<HarnessWorkflowPanel harness={{ ...harness, authState: "authenticated" }} capability={capability} client={api} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  expect(api.start).not.toHaveBeenCalled();
});

it("omits View logs when only workflow activity is available", () => {
  const api = client();
  render(<HarnessWorkflowPanel harness={harness} capability={capability} client={api}
    disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "View logs" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Connection logs" })).not.toBeInTheDocument();
  expect(api.logs).not.toHaveBeenCalled();
});

it("shows login after a retained install receipt completes and refreshed inventory confirms installation", async () => {
  const api = client();
  api.get = vi.fn().mockResolvedValue({ id: "installed", harnessInstanceId: "codex", kind: "install", state: "succeeded", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null });
  const onRefresh = vi.fn();
  render(<HarnessWorkflowPanel harness={harness} capability={{...capability, install: true}} client={api} operationId="installed" disabled={false} onRefresh={onRefresh} onOpenTerminal={vi.fn()} />);
  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", {name: /ChatGPT account/})).toBeEnabled();
  expect(screen.queryByRole("button", {name: "Install"})).not.toBeInTheDocument();
  expect(screen.queryByText(/Not on this computer yet/)).not.toBeInTheDocument();
  expect(api.start).not.toHaveBeenCalled();
});


it.each([false, true])("reconciles confirmed initial login but preserves replacement failure (initial connected=%s)", async initialConnected => {
  const api = client();
  const operation = { id: "late-login", harnessInstanceId: "codex", kind: "login", state: "failed", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: "unavailable" };
  api.get = vi.fn().mockResolvedValue(operation);
  const onStateChange = vi.fn();
  const onOperationId = vi.fn();
  const props = { capability, client: api, operationId: "late-login", disabled: false, onRefresh: vi.fn(), onOpenTerminal: vi.fn(), onStateChange, onOperationId };
  const { rerender } = render(<HarnessWorkflowPanel {...props} harness={{...harness, authState: initialConnected ? "authenticated" : "unauthenticated"}} />);
  await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith("Couldn't connect"));
  if (!initialConnected) {
    rerender(<HarnessWorkflowPanel {...props} harness={{...harness, authState: "unknown"}} />);
    expect(onStateChange).toHaveBeenLastCalledWith("Couldn't connect");
    expect(onOperationId).not.toHaveBeenCalled();
  }
  rerender(<HarnessWorkflowPanel {...props} harness={{...harness, authState: "authenticated"}} />);
  if (initialConnected) {
    expect(onStateChange).toHaveBeenLastCalledWith("Couldn't connect");
    expect(onOperationId).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith(null));
    expect(onOperationId).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("button", {name: /ChatGPT account/})).not.toBeInTheDocument();
  }
});

it('keeps account changes and disconnect unavailable until an active replacement login finishes', async () => {
  const api = client();
  api.get = vi.fn().mockResolvedValue({ id: 'replacement', harnessInstanceId: 'codex', kind: 'login', state: 'running', expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null });
  api.cancel = vi.fn().mockResolvedValue({ id: 'replacement', harnessInstanceId: 'codex', kind: 'login', state: 'cancelled', expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null });
  const disconnect = vi.fn();
  render(<HarnessWorkflowPanel harness={{...harness, authState: 'authenticated'}} capability={capability} client={api} operationId="replacement" disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} onDisconnect={disconnect} advancedConfiguration={<button>Choose model</button>} />);
  await screen.findByText('Finish signing in to ChatGPT');
  expect(screen.getByRole('button', {name: 'Change account'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Disconnect'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name: 'Disconnect'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(disconnect).not.toHaveBeenCalled();
  expect(screen.getByRole('button', {name: 'Choose model'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Cancel'})).toBeEnabled();
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  await waitFor(() => expect(screen.getByRole('button', {name: 'Change account'})).toBeEnabled());
  expect(screen.getByRole('button', {name: 'Disconnect'})).toBeEnabled();
  expect(screen.getByRole('button', {name: 'Choose model'})).toBeEnabled();
  expect(api.cancel).toHaveBeenCalledWith('replacement', expect.any(AbortSignal));
});

it("offers terminal-only supported login behind collapsed Advanced configuration", async () => {
  const api = client();
  api.start = vi.fn().mockResolvedValue({ id: "terminal", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: "tws_1:tt_1", deviceCode: null, authorizationUrl: null, safeFailure: null });
  const openTerminal = vi.fn();
  render(<HarnessWorkflowPanel harness={harness} capability={{ ...capability, loginMethods: ["terminal"], apiKeyProviders: [] }} client={api} disabled={false} onRefresh={vi.fn()} onOpenTerminal={openTerminal} />);
  const summary = screen.getByText("Advanced configuration");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "Sign in in Terminal" }));
  await waitFor(() => expect(openTerminal).toHaveBeenCalledWith("tws_1:tt_1"));
  expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ method: "terminal", harnessInstanceId: "codex" }), expect.any(AbortSignal));
});

it("continues mounted login status after a transient read failure", async () => {
  vi.useFakeTimers();
  const api = client();
  const operation = { id: "poll", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null };
  api.get = vi.fn().mockResolvedValueOnce(operation).mockRejectedValueOnce(new ProviderWorkflowClientError()).mockResolvedValue({ ...operation, state: "succeeded" });
  const refresh = vi.fn();
  try {
    render(<HarnessWorkflowPanel harness={harness} capability={capability} client={api} disabled={false} onRefresh={refresh} onOpenTerminal={vi.fn()} operationId="poll" />);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole("alert")).toHaveTextContent("Connection status is unavailable");
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally { cleanup(); vi.useRealTimers(); }
});

it("rearms bounded status polling after an explicit check following failed cancellation", async () => {
  vi.useFakeTimers();
  const api = client();
  const operation = { id: "cancel-recovery", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null };
  api.get = vi.fn().mockResolvedValueOnce(operation).mockResolvedValueOnce(operation).mockResolvedValue({ ...operation, state: "succeeded" });
  api.cancel = vi.fn().mockRejectedValue(new ProviderWorkflowClientError());
  const refresh = vi.fn();
  try {
    render(<HarnessWorkflowPanel harness={harness} capability={capability} client={api} disabled={false} onRefresh={refresh} onOpenTerminal={vi.fn()} operationId="cancel-recovery" />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(api.get).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check connection" })));
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(api.cancel).toHaveBeenCalledOnce();
  } finally { cleanup(); vi.useRealTimers(); }
});
