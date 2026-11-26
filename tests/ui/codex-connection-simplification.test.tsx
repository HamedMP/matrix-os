// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
afterEach(cleanup);
const device = { id: "openai_device_code", providerId: "openai", authKind: "subscription", method: "device_code", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const terminal = { ...device, id: "openai_terminal", method: "terminal" } as const;
const existing = { ...device, id: "openai_existing_codex", method: "existing_codex" } as const;
const key = { id: "openai_key", providerId: "openai", authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "available" } as const;
export function codexFixture(state: "connected" | "off" | "consent" | "none" | "key" = "connected"): ProviderSettingsSnapshot {
  return { revision: 1, refreshedAt: new Date().toISOString(), access: { mode: "writable" }, supportedActions: ["logout_account", "set_harness_enabled"], configurationHarnessKinds: [],
    harnesses: [{ id: "codex", harness: "codex", displayName: "Codex", enabled: state !== "off", configuredEnabled: state !== "off", installState: "installed", authState: state === "none" ? "unauthenticated" : "authenticated", connectivity: "online", loginMethods: ["device_code", "terminal"], accountIds: ["owner_codex", "old-alias"], selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile", route: { kind: "fixed", providerId: "openai", modelId: "codex:test" } }],
    accounts: ["owner_codex", "old-alias"].map(id => ({ id, providerId: "openai", accessSourceId: "owner_openai_profile", displayName: id === "owner_codex" ? "Synthetic owner" : "Connected ChatGPT account", authMethod: state === "key" ? "api_key" : "terminal", authState: state === "none" ? "unauthenticated" : "authenticated", dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } })),
    accessSources: [{ id: "owner_openai_profile", kind: "provider_account", accountId: "owner_codex", providerId: "openai", displayName: "Native account", fundingKind: state === "key" ? "owner_api_key" : "owner_account", eligibleModelIds: ["codex:test"], readiness: { state: state === "consent" || state === "none" ? "auth_required" : "ready" }, usage: { kind: "unavailable", reason: "unknown" } }], modelProviders: [], gatewayPolicy: null } as unknown as ProviderSettingsSnapshot;
}
function workflow(connectionOption: typeof device | typeof existing = device, state: "running" | "succeeded" | "failed" = "running") {
  const receipt = { id: "login", harnessInstanceId: "codex", kind: "login", state, expiresAt: new Date(Date.now() + 60000).toISOString(), authorizationUrl: connectionOption === device ? "https://auth.openai.com/codex/device" : null, deviceCode: connectionOption === device ? "SYNTHETIC" : null, terminalSessionId: null, safeFailure: state === "failed" ? "unavailable" : null, connectionOption };
  return { receipt, capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code", "terminal"], apiKeyProviders: ["openai"], connectionOptions: [device, terminal, key], install: false, uninstall: false, logs: false }]), startConnection: vi.fn().mockResolvedValue(receipt), submitConnectionKey: vi.fn().mockResolvedValue({ verified: true }), start: vi.fn(), get: vi.fn().mockResolvedValue(receipt), cancel: vi.fn().mockResolvedValue({ ...receipt, state: "cancelled" }), logs: vi.fn(), submitKey: vi.fn() };
}
async function mount(initial = codexFixture(), rejectLogout = false, client = workflow(), afterLogin?: ProviderSettingsSnapshot) {
  const mutate = vi.fn(), refresh = vi.fn(), refreshConnection = vi.fn(), openTerminal = vi.fn(), openAuthorization = vi.fn();
  function App({ capabilityRefreshRevision, workflowClient = client }: {
    capabilityRefreshRevision?: number; workflowClient?: ReturnType<typeof workflow>;
  }) {
    const [snapshot, setSnapshot] = useState(initial);
    return <AgentsProvidersView snapshot={snapshot} capabilityRefreshRevision={capabilityRefreshRevision} selectedHarnessId="codex" onSelectHarness={vi.fn()} onRefresh={() => { refresh(); }} onRefreshForConnection={async receipt => {
      refreshConnection(receipt);
      if (receipt?.state === "succeeded" && afterLogin) {
        setSnapshot(afterLogin);
        return afterLogin;
      }
      return snapshot;
    }}
      onMutate={async intent => { mutate(intent); if (rejectLogout) return false; if (intent.type === "logout_account") setSnapshot(codexFixture("none")); return true; }}
      onOpenTerminal={openTerminal} onOpenAuthorizationUrl={openAuthorization} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} workflowClient={workflowClient as never}/>;
  }
  const view = render(<App/>); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  const refreshWorkflowCapabilities = (revision: number, workflowClient = client) => act(async () => {
    view.rerender(<App capabilityRefreshRevision={revision} workflowClient={workflowClient}/>);
  });
  return { client, mutate, refresh, refreshConnection, openTerminal, openAuthorization, refreshWorkflowCapabilities, ...view };
}
async function existingWorkflow(state: "succeeded" | "failed" = "succeeded") {
  const client = workflow(existing, state), capability = (await client.capabilities())[0]!;
  client.capabilities.mockResolvedValue([{ ...capability, loginMethods: ["device_code", "terminal", "existing_codex"], connectionOptions: [device, terminal, existing, key] }]);
  return client;
}
it.each(["connected", "key"] as const)("shows one selected-account lifecycle and no extra methods or disable-only Disconnect (%s)", async state => {
  const { mutate, client } = await mount(codexFixture(state));
  expect(screen.getByRole("button", { name: "Change account" })).toBeEnabled();
  expect(screen.getAllByRole("button", { name: /Log out/ })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Connection options" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Sign in with a code|Sign in with Codex CLI|OpenAI API key/ })).toBeNull();
  expect(mutate).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
});
it("cancels change account before any logout and preserves the connected card", async () => {
  const { mutate, client } = await mount(); fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  const dialog = within(screen.getByRole("dialog", { name: "Change Codex account?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(mutate).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
  expect(screen.getAllByRole("region", { name: "Codex connection" }).some(node => node.classList.contains("matrix-ap-connected"))).toBe(true);
});
it("logs out only the selected account before revealing normal new-account sign-in", async () => {
  const { mutate, client } = await mount(); fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log out and change account" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "logout_account", accountId: "owner_codex" }));
  const connect = await screen.findByRole("button", { name: /ChatGPT account · Sign in with a code/ });
  expect(client.startConnection).not.toHaveBeenCalled(); fireEvent.click(connect);
  await waitFor(() => expect(client.startConnection).toHaveBeenCalledOnce());
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(client.cancel).toHaveBeenCalledOnce());
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Change account" })).toBeNull();
});
it("does not start replacement login after rejected/uncertain logout", async () => {
  const { mutate, client } = await mount(codexFixture(), true); fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log out and change account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/sign-out/i);
  expect(mutate).toHaveBeenCalledOnce(); expect(client.startConnection).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /ChatGPT account · Sign in with a code/ })).toBeNull();
});
it.each(["off", "consent"] as const)("offers explicit normal native Reconnect for historical saved state without enabling on read (%s)", async state => {
  const { mutate, client } = await mount(codexFixture(state));
  expect(screen.getByRole("region", { name: "Codex saved account" })).toBeVisible();
  const button = screen.getByRole("button", { name: "Reconnect" });
  expect(mutate).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(client.startConnection).toHaveBeenCalledWith(expect.objectContaining({ harnessInstanceId: "codex", optionId: "openai_device_code" }), expect.any(AbortSignal)));
  expect(mutate).not.toHaveBeenCalled();
});
it("retains initial sign-in and API-key choices without authenticated identity", async () => {
  await mount(codexFixture("none"));
  expect(screen.getByRole("button", { name: /ChatGPT account · Sign in with a code/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /ChatGPT account · Sign in with Codex CLI/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /OpenAI API key/ })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Log out|Change account|Reconnect/ })).toBeNull();
});
it("keeps the active Codex device sign-in when background workflow capabilities time out", async () => {
  const client = workflow();
  const started = Promise.withResolvers<typeof client.receipt>();
  client.startConnection.mockReturnValueOnce(started.promise);
  const { refreshWorkflowCapabilities, openAuthorization, openTerminal } = await mount(codexFixture("none"), false, client);

  fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Sign in with a code/ }));
  expect(screen.getByRole("status", { name: "Starting sign-in" })).toBeVisible();
  const startSignal = client.startConnection.mock.calls[0]![1] as AbortSignal;
  client.capabilities.mockRejectedValueOnce(new ProviderWorkflowClientError("unavailable"));
  await refreshWorkflowCapabilities(1);

  expect(startSignal.aborted).toBe(false);
  expect(screen.getByRole("status", { name: "Starting sign-in" })).toBeVisible();
  await act(async () => started.resolve(client.receipt));
  expect(await screen.findByRole("button", { name: "Open sign-in page" })).toBeEnabled();
  expect(client.startConnection).toHaveBeenCalledOnce();
  expect(openAuthorization).not.toHaveBeenCalled();
  expect(openTerminal).not.toHaveBeenCalled();
});
it.each(["forbidden", "unauthorized", "removed", "switched"] as const)(
  "dismisses a pending sign-in when its workflow scope is %s",
  async reason => {
    const client = workflow();
    const started = Promise.withResolvers<typeof client.receipt>();
    client.startConnection.mockReturnValueOnce(started.promise);
    const { refreshWorkflowCapabilities, openAuthorization } = await mount(codexFixture("none"), false, client);
    fireEvent.click(screen.getByRole("button", { name: /ChatGPT account · Sign in with a code/ }));
    const startSignal = client.startConnection.mock.calls[0]![1] as AbortSignal;

    if (reason === "switched") {
      const next = workflow();
      next.capabilities.mockRejectedValueOnce(new ProviderWorkflowClientError("unavailable"));
      await refreshWorkflowCapabilities(1, next);
    } else {
      if (reason === "removed") client.capabilities.mockResolvedValueOnce([]);
      else client.capabilities.mockRejectedValueOnce(new ProviderWorkflowClientError(reason));
      await refreshWorkflowCapabilities(1);
    }
    await act(async () => started.resolve(client.receipt));

    expect(startSignal.aborted).toBe(true);
    expect(screen.queryByRole("status", { name: "Starting sign-in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in with a code|Open sign-in page/ })).not.toBeInTheDocument();
    expect(openAuthorization).not.toHaveBeenCalled();
  },
);
it.each(["none", "consent"] as const)("uses the verified existing account only after a click from %s Settings", async initial => {
  const client = await existingWorkflow();
  const pending = Promise.withResolvers<typeof client.receipt>();
  client.startConnection.mockReturnValueOnce(pending.promise);
  const { mutate, refreshConnection, openTerminal, openAuthorization } = await mount(codexFixture(initial), false, client, codexFixture());
  const adopt = screen.getByRole("button", { name: /^Use existing Codex account/ });
  expect(adopt).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Sign in with a code|Sign in with Codex CLI/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Codex.*Connected/ })).not.toBeInTheDocument();
  if (initial === "none") expect(screen.getByRole("button", { name: /OpenAI API key/ })).toBeEnabled();
  expect(client.startConnection).not.toHaveBeenCalled();
  fireEvent.click(adopt);
  expect(screen.getByRole("status", { name: "Verifying existing Codex account" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: /Finish signing in/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Codex.*Connected/ })).not.toBeInTheDocument();
  expect(refreshConnection).not.toHaveBeenCalled();
  await act(async () => pending.resolve(client.receipt));
  expect(await screen.findByRole("button", { name: /^Codex.*Connected/ })).toBeVisible();
  expect(client.startConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ optionId: "openai_existing_codex", harnessInstanceId: "codex" }), expect.any(AbortSignal));
  expect(refreshConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "succeeded", connectionOption: existing }));
  expect(mutate).not.toHaveBeenCalled();
  expect(openTerminal).not.toHaveBeenCalled();
  expect(openAuthorization).not.toHaveBeenCalled();
});
it("keeps one saved-account action and its existing refresh after a verification failure", async () => {
  const client = await existingWorkflow("failed");
  const { mutate, refresh } = await mount(codexFixture("consent"), false, client);
  const row = screen.getByRole("group", { name: "Codex connection actions" });
  fireEvent.click(within(row).getByRole("button", { name: "Use existing Codex account" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not verify the existing Codex account");
  expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  const adopt = screen.getByRole("button", { name: /^Use existing Codex account/ });
  expect(adopt).toBeEnabled();
  expect(adopt).toHaveClass("matrix-ap-button-primary");
  fireEvent.click(within(row).getByRole("button", { name: "Check again" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(client.startConnection).toHaveBeenCalledOnce();
  expect(mutate).not.toHaveBeenCalled();
});
it("offers one saved existing-account action after a previous sign-in attempt failed", async () => {
  const client = await existingWorkflow();
  const capability = (await client.capabilities())[0]!;
  client.capabilities.mockResolvedValue([{ ...capability, activeOperationId: client.receipt.id } as never]);
  client.get.mockResolvedValue({ ...client.receipt, state: "failed", safeFailure: "unavailable", connectionOption: terminal });
  await mount(codexFixture("consent"), false, client);
  const alert = await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: /^Use existing Codex account/ })).toBeEnabled();
  expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Sign in with a code|Sign in with Codex CLI/ })).not.toBeInTheDocument();
  expect(client.startConnection).not.toHaveBeenCalled();
});
it.each(["workflow", "start"] as const)("shows a failed existing-account %s with a Settings refresh and no sign-in fallback", async failure => {
  const client = await existingWorkflow("failed");
  if (failure === "start") client.startConnection.mockRejectedValueOnce(new Error("fixture preflight failed"));
  const { refresh, refreshConnection, openTerminal, openAuthorization } = await mount(codexFixture("none"), false, client);
  fireEvent.click(screen.getByRole("button", { name: /^Use existing Codex account/ }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(failure === "workflow" ? "Could not verify the existing Codex account" : "The connection could not be updated.");
  fireEvent.click(within(alert).getByRole("button", { name: "Check again" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(client.startConnection).toHaveBeenCalledOnce();
  expect(refreshConnection).not.toHaveBeenCalled();
  expect(openTerminal).not.toHaveBeenCalled();
  expect(openAuthorization).not.toHaveBeenCalled();
});
it("cannot mutate or reconnect a read-only saved account", async () => {
  const initial = codexFixture("consent"); initial.access = { mode: "read_only", reason: "remote_policy" };
  const { mutate, client } = await mount(initial);
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Change account" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  expect(mutate).not.toHaveBeenCalled(); expect(client.startConnection).not.toHaveBeenCalled();
});
it("does not restore old credentials or enable anything when new-account sign-in fails", async () => {
  const { mutate, client } = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log out and change account" }));
  const button = await screen.findByRole("button", { name: /ChatGPT account · Sign in with a code/ });
  client.startConnection.mockRejectedValueOnce(new Error("private-token-do-not-render"));
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).not.toHaveTextContent("private-token-do-not-render");
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "logout_account", accountId: "owner_codex" });
  expect(screen.queryByRole("button", { name: "Change account" })).toBeNull();
});
it("confirms native API-key logout and retains normal key entry only after sign-out", async () => {
  const { mutate, client } = await mount(codexFixture("key"));
  fireEvent.click(screen.getByRole("button", { name: /Log out/ }));
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Log out of Codex?" })).getByRole("button", { name: "Log out" }));
  fireEvent.click(await screen.findByRole("button", { name: /OpenAI API key/ }));
  expect(screen.getByLabelText("Paste your OpenAI API key")).toBeVisible();
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "logout_account", accountId: "owner_codex" });
  expect(client.submitConnectionKey).not.toHaveBeenCalled();
});
it("reconnects a saved API key through fresh enablement without starting subscription login", async () => {
  const initial = codexFixture("key"); initial.harnesses[0]!.enabled = false; initial.harnesses[0]!.configuredEnabled = false;
  const { mutate, client } = await mount(initial);
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "set_harness_enabled", harnessInstanceId: "codex", enabled: true }));
  expect(client.startConnection).not.toHaveBeenCalled(); expect(client.submitConnectionKey).not.toHaveBeenCalled();
});
it("reconnects a saved native account when code login alone is qualified", async () => {
  const client = workflow(), capability = (await client.capabilities())[0]!;
  client.capabilities.mockResolvedValue([{ ...capability, loginMethods: ["device_code"], connectionOptions: [device] }]);
  await mount(codexFixture("consent"), false, client);
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(client.startConnection).toHaveBeenCalledWith(expect.objectContaining({ optionId: "openai_device_code" }), expect.any(AbortSignal)));
});
it("does not offer Change account when the client cannot start any replacement method", async () => {
  const client = workflow(); client.startConnection = undefined as never; client.submitConnectionKey = undefined as never;
  const { mutate } = await mount(codexFixture(), false, client);
  expect(screen.queryByRole("button", { name: "Change account" })).toBeNull();
  expect(screen.getByRole("button", { name: /Log out/ })).toBeEnabled(); expect(mutate).not.toHaveBeenCalled();
});
it.each(["pending", "failed"])("does not reconnect while the known operation status is unresolved (%s)", async status => {
  const client = workflow(), capability = (await client.capabilities())[0]!;
  client.capabilities.mockResolvedValue([{ ...capability, activeOperationId: "prior-login" } as never]);
  if (status === "pending") client.get.mockImplementation(() => new Promise(() => {}));
  else client.get.mockRejectedValue(new Error("synthetic unavailable"));
  await mount(codexFixture("consent"), false, client);
  await waitFor(() => expect(client.get).toHaveBeenCalled());
  const reconnect = screen.getByRole("button", { name: "Reconnect" });
  expect(reconnect).toBeDisabled(); fireEvent.click(reconnect);
  expect(client.startConnection).not.toHaveBeenCalled();
});

// ENG-523: a saved Codex login that Matrix may not use yet reads as one state:
// the row badge, the account card and its single primary action agree.
it("shows a saved Codex login that needs sign-in consistently with one primary Reconnect", async () => {
  await mount(codexFixture("consent"));
  expect(screen.getByRole("button", { name: /^Codex.*Needs sign-in/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Codex.*Not connected/ })).toBeNull();
  const card = screen.getByRole("region", { name: "Codex saved account" });
  expect(within(card).getByText(/Sign in again so Chat can use this account/)).toBeVisible();
  expect(within(card).queryByRole("button")).toBeNull();
  const row = screen.getByRole("group", { name: "Codex connection actions" });
  const buttons = within(row).getAllByRole("button");
  expect(buttons.map(button => button.textContent)).toEqual(["Reconnect", "Check again", "Change account", "Log out"]);
  expect(buttons.filter(button => button.classList.contains("matrix-ap-button-primary"))).toEqual([buttons[0]]);
  for (const button of buttons) expect(button).toHaveClass("matrix-ap-button");
  expect(screen.queryByRole("button", { name: "Check account again" })).toBeNull();
});
it("shows connected Codex secondary actions in one row without a primary action", async () => {
  const { refresh } = await mount(codexFixture("connected"));
  expect(screen.getByRole("button", { name: /^Codex.*Connected/ })).toBeVisible();
  const row = screen.getByRole("group", { name: "Codex connection actions" });
  const buttons = within(row).getAllByRole("button");
  expect(buttons.map(button => button.textContent)).toEqual(["Check again", "Change account", "Log out"]);
  expect(row.querySelector(".matrix-ap-button-primary")).toBeNull();
  expect(screen.queryByRole("button", { name: "Check account again" })).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Check again" }));
  expect(refresh).toHaveBeenCalled();
});
it("explains a saved Codex account that is only Off without asking to sign in again", async () => {
  await mount(codexFixture("off"));
  const card = screen.getByRole("region", { name: "Codex saved account" });
  expect(within(card).getByText(/Codex is off on this Computer/)).toBeVisible();
  expect(within(card).queryByText(/Sign in again/)).toBeNull();
});
it("keeps the account card's Check account again when Codex workflow capabilities are unavailable", async () => {
  const client = workflow(); client.capabilities.mockRejectedValue(new Error("capabilities unavailable"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await mount(codexFixture("connected"), false, client);
    expect(await screen.findByRole("button", { name: "Check account again" })).toBeVisible();
  } finally { warn.mockRestore(); }
});
