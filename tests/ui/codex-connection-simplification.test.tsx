// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
afterEach(cleanup);
const device = { id: "openai_device_code", providerId: "openai", authKind: "subscription", method: "device_code", billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const terminal = { ...device, id: "openai_terminal", method: "terminal" } as const;
const key = { id: "openai_key", providerId: "openai", authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "available" } as const;
export function codexFixture(state: "connected" | "off" | "consent" | "none" | "key" = "connected"): ProviderSettingsSnapshot {
  return { revision: 1, refreshedAt: new Date().toISOString(), access: { mode: "writable" }, supportedActions: ["logout_account", "set_harness_enabled"], configurationHarnessKinds: [],
    harnesses: [{ id: "codex", harness: "codex", displayName: "Codex", enabled: state !== "off", configuredEnabled: state !== "off", installState: "installed", authState: state === "none" ? "unauthenticated" : "authenticated", connectivity: "online", loginMethods: ["device_code", "terminal"], accountIds: ["owner_codex", "old-alias"], selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile", route: { kind: "fixed", providerId: "openai", modelId: "codex:test" } }],
    accounts: ["owner_codex", "old-alias"].map(id => ({ id, providerId: "openai", accessSourceId: "owner_openai_profile", displayName: id === "owner_codex" ? "Synthetic owner" : "Connected ChatGPT account", authMethod: state === "key" ? "api_key" : "terminal", authState: state === "none" ? "unauthenticated" : "authenticated", dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } })),
    accessSources: [{ id: "owner_openai_profile", kind: "provider_account", accountId: "owner_codex", providerId: "openai", displayName: "Native account", fundingKind: state === "key" ? "owner_api_key" : "owner_account", eligibleModelIds: ["codex:test"], readiness: { state: state === "consent" || state === "none" ? "auth_required" : "ready" }, usage: { kind: "unavailable", reason: "unknown" } }], modelProviders: [], gatewayPolicy: null } as unknown as ProviderSettingsSnapshot;
}
function workflow() {
  const receipt = { id: "login", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), authorizationUrl: "https://auth.openai.com/codex/device", deviceCode: "SYNTHETIC", terminalSessionId: null, safeFailure: null, connectionOption: device };
  return { capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code", "terminal"], apiKeyProviders: ["openai"], connectionOptions: [device, terminal, key], install: false, uninstall: false, logs: false }]), startConnection: vi.fn().mockResolvedValue(receipt), submitConnectionKey: vi.fn().mockResolvedValue({ verified: true }), start: vi.fn(), get: vi.fn().mockResolvedValue(receipt), cancel: vi.fn().mockResolvedValue({ ...receipt, state: "cancelled" }), logs: vi.fn(), submitKey: vi.fn() };
}
async function mount(initial = codexFixture(), rejectLogout = false, client = workflow()) {
  const mutate = vi.fn(), refresh = vi.fn();
  function App() {
    const [snapshot, setSnapshot] = useState(initial);
    return <AgentsProvidersView snapshot={snapshot} selectedHarnessId="codex" onSelectHarness={vi.fn()} onRefresh={() => { refresh(); }} onRefreshForConnection={async () => snapshot}
      onMutate={async intent => { mutate(intent); if (rejectLogout) return false; if (intent.type === "logout_account") setSnapshot(codexFixture("none")); return true; }}
      onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} workflowClient={client as never}/>;
  }
  const view = render(<App/>); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  return { client, mutate, refresh, ...view };
}
it.each(["connected", "key"] as const)("shows one selected-account lifecycle and no extra methods or disable-only Disconnect (%s)", async state => {
  const { mutate, client } = await mount(codexFixture(state));
  expect(screen.getByRole("button", { name: "Change account" })).toBeEnabled();
  expect(screen.getAllByRole("button", { name: /Log out/ })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Connection options" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Sign in with a code|Log in in Terminal|OpenAI API key/ })).toBeNull();
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
  expect(screen.getByRole("button", { name: /OpenAI API key/ })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /Log out|Change account|Reconnect/ })).toBeNull();
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
