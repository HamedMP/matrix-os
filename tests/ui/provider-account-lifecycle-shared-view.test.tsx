// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";

afterEach(cleanup);
function fixture(): ProviderSettingsSnapshot {
  return { refreshedAt: new Date().toISOString(), access: { mode: "writable" },
    supportedActions: ["logout_account", "remove_account", "reassign_account", "set_harness_enabled"], configurationHarnessKinds: [],
    harnesses: [{ id: "codex", harness: "codex", displayName: "Codex", enabled: true, configuredEnabled: true,
      installState: "installed", authState: "authenticated", connectivity: "online", loginMethods: ["terminal"],
      accountIds: ["personal"], selectedAccountId: "personal", accessSourceId: "personal-source",
      route: { kind: "fixed", providerId: "openai", modelId: "codex:test" } }],
    accounts: [{ id: "personal", providerId: "openai", accessSourceId: "personal-source", displayName: "Personal", authMethod: "terminal", authState: "authenticated",
      dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } }],
    accessSources: [{ id: "personal-source", kind: "provider_account", accountId: "personal", providerId: "openai", displayName: "Personal",
      fundingKind: "owner_account", eligibleModelIds: ["codex:test"], readiness: { state: "ready" }, usage: { kind: "unavailable", reason: "unknown" } }],
    modelProviders: [], gatewayPolicy: null } as unknown as ProviderSettingsSnapshot;
}
function client() {
  return { capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false }]),
    start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
}
async function mount(snapshot = fixture(), overrides: Partial<React.ComponentProps<typeof AgentsProvidersView>> = {}) {
  const workflowClient = client();
  const props = { snapshot, selectedHarnessId: "codex", onSelectHarness: vi.fn(), onRefresh: vi.fn(), onMutate: vi.fn().mockResolvedValue(true), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn(), workflowClient: workflowClient as never, ...overrides };
  const result = render(<AgentsProvidersView {...props} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  return { ...result, props, workflowClient };
}

it("keeps guided logout, account removal and agent disconnect separate without restoring settings drawers", async () => {
  const { props } = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Log out Personal" }));
  await waitFor(() => expect(props.onMutate).toHaveBeenCalledExactlyOnceWith({ type: "logout_account", accountId: "personal" }));
  await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Remove Personal" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove Personal" })).getByRole("button", { name: "Remove account" }));
  await waitFor(() => expect(props.onMutate).toHaveBeenLastCalledWith({ type: "remove_account", accountId: "personal", dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 }, confirmation: "remove_account" }));
  expect(props.onMutate).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_harness_enabled" }));
  expect(screen.queryByText("Manage saved accounts")).toBeNull();
  expect(screen.queryByText("Advanced configuration")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});

it("requires dependency reassignment before removing a guided account in use", async () => {
  const snapshot = fixture(); snapshot.accounts[0]!.dependencies = { activeChatCount: 2, resumableChatCount: 1, harnessInstanceCount: 1 };
  snapshot.accounts.push({ ...snapshot.accounts[0]!, id: "work", displayName: "Work", accessSourceId: "work-source" });
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: "work-source", accountId: "work", displayName: "Work" });
  const { props } = await mount(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "Remove Personal" }));
  const dialog = within(screen.getByRole("dialog", { name: "Remove Personal" }));
  expect(dialog.getByText(/2 active chats/)).toBeVisible();
  expect(dialog.queryByRole("button", { name: "Remove account" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Reassign dependencies" }));
  await waitFor(() => expect(props.onMutate).toHaveBeenCalledExactlyOnceWith({ type: "reassign_account", fromAccountId: "personal", target: { kind: "account", accountId: "work" }, scope: "all_dependencies", dependencyGuard: { activeChatCount: 2, resumableChatCount: 1, harnessInstanceCount: 1 } }));
  expect(props.onMutate).not.toHaveBeenCalledWith(expect.objectContaining({ type: "remove_account" }));
});
it("does not invent server account action capabilities", async () => {
  const snapshot = fixture(); snapshot.supportedActions = ["set_harness_enabled"];
  await mount(snapshot);
  expect(screen.queryByRole("button", { name: "Log out Personal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Personal" })).toBeNull();
});
it("keeps guided account actions disabled for read-only viewers", async () => {
  const snapshot = fixture(); snapshot.access = { mode: "read_only", reason: "remote_policy" };
  const { props } = await mount(snapshot);
  expect(screen.getByRole("button", { name: "Log out Personal" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Personal" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Log out Personal" }));
  expect(props.onMutate).not.toHaveBeenCalled();
});
it("guards guided logout and removal while the exact login operation runs", async () => {
  const workflowClient = client();
  const capability = (await workflowClient.capabilities())[0];
  workflowClient.capabilities.mockResolvedValue([{ ...capability, activeOperationId: "login" }]);
  const receipt = { id: "login", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60_000).toISOString(), deviceCode: null, authorizationUrl: null, terminalSessionId: null, safeFailure: null };
  workflowClient.get.mockResolvedValue(receipt); workflowClient.cancel.mockResolvedValue({ ...receipt, state: "cancelled" });
  const { props } = await mount(fixture(), { workflowClient: workflowClient as never });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Codex/ })).toHaveTextContent("Connecting"));
  expect(screen.getByRole("button", { name: "Log out Personal" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Personal" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove Personal" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(props.onMutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Log out Personal" })).toBeEnabled());
});
it.each([false, new Error("private credential path")])("retains a guided account after failed logout (%s)", async failure => {
  const onMutate = typeof failure === "boolean" ? vi.fn().mockResolvedValue(failure) : vi.fn().mockRejectedValue(failure);
  const { props } = await mount(fixture(), { onMutate });
  fireEvent.click(screen.getByRole("button", { name: "Log out Personal" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent("private credential path");
  expect(screen.getByRole("button", { name: /^Codex/ })).toHaveTextContent("Connected");
  expect(props.onRefresh).not.toHaveBeenCalled();
});

it.each(["running", "failed", "cancelled"])("fences account actions until the known operation is observed (%s)", async state => {
  const workflowClient = client(); const capability = (await workflowClient.capabilities())[0];
  workflowClient.capabilities.mockResolvedValue([{ ...capability, activeOperationId: "known" }]);
  let resolve!: (value: unknown) => void;
  workflowClient.get.mockImplementation(() => new Promise(r => { resolve = r; }));
  const { props } = await mount(fixture(), { workflowClient: workflowClient as never });
  await waitFor(() => expect(workflowClient.get).toHaveBeenCalledWith("known", expect.any(AbortSignal)));
  expect(screen.getByRole("button", { name: "Log out Personal" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Personal" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Log out Personal" }));
  expect(props.onMutate).not.toHaveBeenCalled();
  await act(async () => { resolve({ id: "known", harnessInstanceId: "codex", kind: "login", state, expiresAt: new Date(Date.now() + 60_000).toISOString(), safeFailure: state === "failed" ? "failed" : null, deviceCode: null, authorizationUrl: null, terminalSessionId: null }); });
  if (state === "running") expect(screen.getByRole("button", { name: "Log out Personal" })).toBeDisabled();
  else {
    expect(screen.getByRole("button", { name: "Log out Personal" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Personal" })).toBeEnabled();
  }
});
