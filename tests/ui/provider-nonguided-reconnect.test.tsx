// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";

afterEach(cleanup);
function fixture(enabled = false): ProviderSettingsSnapshot {
  const now = new Date().toISOString();
  return { refreshedAt: now, access: { mode: "writable" }, supportedActions: ["set_harness_enabled"], configurationHarnessKinds: ["hermes"],
    harnesses: [{ id: "hermes", harness: "hermes", displayName: "Hermes", enabled, configuredEnabled: enabled,
      installState: "installed", authState: "unknown", connectivity: "online", accountIds: [], selectedAccountId: null,
      accessSourceId: "native", configuredAccessSourceId: "native", loginMethods: [], route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:test" } }],
    accounts: [], accessSources: [{ id: "native", kind: "harness_profile", harness: "hermes", providerId: "openai-codex", accountId: null,
      displayName: "Native account", fundingKind: "owner_subscription", eligibleModelIds: ["openai-codex:test"], readiness: { state: "unknown" },
      localObservation: { state: "present_unverified", checkedAt: now, staleAfter: new Date(Date.now() + 60_000).toISOString() },
      usage: { kind: "unavailable", reason: "unknown" } }],
    modelProviders: [{ id: "openai-codex", displayName: "ChatGPT", models: [{ id: "openai-codex:test", displayName: "Test", enabled: true }] }], gatewayPolicy: null } as unknown as ProviderSettingsSnapshot;
}
function props(snapshot = fixture()) {
  return { snapshot, selectedHarnessId: "hermes", onSelectHarness: vi.fn(), onRefresh: vi.fn(), onRefreshForConnection: vi.fn().mockResolvedValue(fixture()), onMutate: vi.fn().mockResolvedValue(true), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn() };
}
it("reconnects a non-guided saved connection after deliberate disconnect without changing credentials or routing", async () => {
  const p = props(fixture(true)); const { rerender } = render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(p.onMutate).toHaveBeenCalledExactlyOnceWith({ type: "set_harness_enabled", harnessInstanceId: "hermes", enabled: false }));
  const off = fixture(); rerender(<AgentsProvidersView {...p} snapshot={off} />);
  expect(p.onRefreshForConnection).not.toHaveBeenCalled();
  const connect = screen.getByRole("button", { name: "Connect saved connection" });
  expect(screen.queryByRole("switch")).toBeNull();
  fireEvent.click(connect);
  await waitFor(() => expect(p.onRefreshForConnection).toHaveBeenCalledOnce());
  await waitFor(() => expect(p.onMutate).toHaveBeenLastCalledWith({ type: "set_harness_enabled", harnessInstanceId: "hermes", enabled: true }));
  expect(p.onMutate).toHaveBeenCalledTimes(2);
  expect(off.harnesses[0]!.configuredEnabled).toBe(false);
});

it.each(["permission", "credential", "route", "source", "account", "capability"])("keeps a non-guided saved connection Off when fresh %s changes", async change => {
  const p = props(); const fresh = fixture();
  if (change === "permission") fresh.access = { mode: "read_only", reason: "remote_policy" };
  if (change === "credential") fresh.accessSources[0]!.localObservation!.state = "absent";
  if (change === "route") fresh.harnesses[0]!.route.modelId = "other";
  if (change === "source") fresh.harnesses[0]!.accessSourceId = "other";
  if (change === "account") fresh.harnesses[0]!.selectedAccountId = "other";
  if (change === "capability") fresh.supportedActions = [];
  p.onRefreshForConnection.mockResolvedValue(fresh);
  render(<AgentsProvidersView {...p} />); fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  expect(p.onMutate).not.toHaveBeenCalled(); expect(p.onRefreshForConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Connect saved connection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Changes were not saved");
  expect(p.onMutate).not.toHaveBeenCalled(); expect(p.snapshot.harnesses[0]!.configuredEnabled).toBe(false);
});
it("does not restore Off on read and disables reconnect without owner permission or a scoped refresh", () => {
  const p = props(); p.snapshot.access = { mode: "read_only", reason: "remote_policy" };
  const { rerender } = render(<AgentsProvidersView {...p} />); fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  expect(screen.getByRole("button", { name: "Connect saved connection" })).toBeDisabled();
  rerender(<AgentsProvidersView {...p} snapshot={fixture()} onRefreshForConnection={undefined} />);
  expect(screen.getByRole("button", { name: "Connect saved connection" })).toBeDisabled();
  expect(p.onMutate).not.toHaveBeenCalled(); expect(p.onRefreshForConnection).not.toHaveBeenCalled();
});
it.each(["refresh", "rejection", "false"])("retains Off and shows a safe error after reconnect %s fails", async mode => {
  const p = props();
  if (mode === "refresh") p.onRefreshForConnection.mockRejectedValue(new Error("private token"));
  if (mode === "rejection") p.onMutate.mockRejectedValue(new Error("private token"));
  if (mode === "false") p.onMutate.mockResolvedValue(false);
  render(<AgentsProvidersView {...p} />); fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Connect saved connection" }));
  const alert = await screen.findByRole("alert"); expect(alert).toHaveTextContent("Changes were not saved"); expect(alert).not.toHaveTextContent("private token");
  expect(screen.getByRole("button", { name: /^Hermes/ })).toHaveTextContent("Not connected");
  expect(p.snapshot.harnesses[0]!.configuredEnabled).toBe(false);
});

it("rejects a former workflow owner's pending reconnect after scope replacement", async () => {
  const p = props(); let resolve!: (value: ProviderSettingsSnapshot) => void;
  p.onRefreshForConnection.mockImplementation(() => new Promise(r => { resolve = r; }));
  const oldClient = { capabilities: vi.fn().mockResolvedValue([]) };
  const nextClient = { capabilities: vi.fn().mockResolvedValue([]) };
  const { rerender } = render(<AgentsProvidersView {...p} workflowClient={oldClient as never} />);
  await act(async () => {}); fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Connect saved connection" }));
  expect(p.onRefreshForConnection).toHaveBeenCalledOnce();
  rerender(<AgentsProvidersView {...p} workflowClient={nextClient as never} />);
  await act(async () => { resolve(fixture()); });
  expect(p.onMutate).not.toHaveBeenCalled(); expect(p.snapshot.harnesses[0]!.configuredEnabled).toBe(false);
});
