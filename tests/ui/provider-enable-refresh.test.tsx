// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useHarnessEnablement, canRefreshNativeEnable } from "../../packages/ui/src/agents-providers/use-harness-enablement";
// Exercise the internal admission helper directly; Settings no longer renders Enable.
function AgentsProvidersView(p: ReturnType<typeof props> & { onRefreshForConnection?: (() => Promise<ProviderSettingsSnapshot | null>) }) {
  const state = useHarnessEnablement({ snapshot: p.snapshot, refresh: p.onRefreshForConnection, mutate: p.onMutate });
  const agent = p.snapshot.harnesses[0]!;
  const enabled = agent.configuredEnabled ?? agent.enabled;
  return <><button>Hermes</button><input type="checkbox" role="switch" aria-label="Enable Hermes" checked={enabled}
    disabled={state.pending || (!enabled && canRefreshNativeEnable(agent, p.snapshot.accessSources) && !p.onRefreshForConnection)}
    onChange={() => { void state.enable(agent); }} />{state.error ? <p>{state.error}</p> : null}</>;
}

afterEach(cleanup);
function fixture(): ProviderSettingsSnapshot {
  return {
    harnesses: [{ id: "hermes", harness: "hermes", displayName: "Hermes", installState: "installed", authState: "unknown", connectivity: "unknown", enabled: false, configuredEnabled: false, accessSourceId: "native", accountIds: [], selectedAccountId: null, loginMethods: ["terminal"], route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:test" } }],
    accounts: [], accessSources: [{ id: "native", kind: "harness_profile", harness: "hermes", providerId: "openai-codex", accountId: null, displayName: "Native subscription", fundingKind: "owner_subscription", eligibleModelIds: ["openai-codex:test"], readiness: { state: "unknown" }, localObservation: { state: "present_unverified", checkedAt: "2026-01-01T00:00:00Z", staleAfter: "2026-01-01T00:00:05Z" } }],
    modelProviders: [{ id: "openai-codex", displayName: "ChatGPT", models: [{ id: "openai-codex:test", displayName: "Test", enabled: true }] }], gatewayPolicy: null, configurationHarnessKinds: ["hermes"], supportedActions: ["set_harness_enabled"], access: { mode: "writable" }, refreshedAt: "2026-01-01T00:00:08Z",
  } as unknown as ProviderSettingsSnapshot;
}
function props() { return { snapshot: fixture(), selectedHarnessId: "hermes", onSelectHarness: vi.fn(), onMutate: vi.fn().mockResolvedValue(true), onRefresh: vi.fn(), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn(), onRefreshForConnection: vi.fn().mockResolvedValue(fixture()) }; }
it("refreshes an expired native observation on explicit Enable without imposing a five-second click window", async () => {
  const p = props();
  let resolve!: (snapshot: ProviderSettingsSnapshot) => void;
  p.onRefreshForConnection.mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  const toggle = screen.getByRole("switch", { name: "Enable Hermes" });
  expect(toggle).toBeEnabled();
  fireEvent.click(toggle);
  expect(p.onRefreshForConnection).toHaveBeenCalledTimes(1);
  expect(p.onMutate).not.toHaveBeenCalled();
  expect(toggle).toBeDisabled();
  // A delayed response can already be past staleAfter. It is evidence for an
  // explicit request only; the server must revalidate at mutation admission.
  resolve(fixture());
  await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith({ type: "set_harness_enabled", harnessInstanceId: "hermes", enabled: true }));
});
it.each(["scope", "route", "provider", "source", "account", "absent", "readonly", "model_inventory", "model_disabled", "model_eligibility", "capability", "installation", "readiness"])("does not enable after refresh changes %s", async kind => {
  const p = props(); const refreshed = fixture(); const agent = refreshed.harnesses[0]!;
  if (kind === "scope") p.onRefreshForConnection.mockResolvedValue(null as never);
  else {
    if (kind === "route") agent.route.modelId = "other";
    if (kind === "provider") agent.route.providerId = "other";
    if (kind === "source") agent.accessSourceId = "other";
    if (kind === "account") agent.selectedAccountId = "other";
    if (kind === "absent") refreshed.accessSources[0]!.localObservation!.state = "absent";
    if (kind === "readonly") refreshed.access.mode = "read_only";
    if (kind === "model_inventory") refreshed.modelProviders[0]!.models = [];
    if (kind === "model_disabled") refreshed.modelProviders[0]!.models[0]!.enabled = false;
    if (kind === "model_eligibility") refreshed.accessSources[0]!.eligibleModelIds = [];
    if (kind === "capability") refreshed.supportedActions = [];
    if (kind === "installation") agent.installState = "missing";
    if (kind === "readiness") refreshed.accessSources[0]!.readiness.state = "auth_required";
    p.onRefreshForConnection.mockResolvedValue(refreshed);
  }
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Hermes" }));
  await screen.findByText("Changes were not saved. Refresh and try again.");
  expect(p.onMutate).not.toHaveBeenCalled();
});

it("requires a deliberate click and coalesces repeated clicks while refreshing", async () => {
  const p = props(); let resolve!: (snapshot: ProviderSettingsSnapshot) => void;
  p.onRefreshForConnection.mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  expect(p.onRefreshForConnection).not.toHaveBeenCalled();
  expect(p.onMutate).not.toHaveBeenCalled();
  const toggle = screen.getByRole("switch", { name: "Enable Hermes" });
  fireEvent.click(toggle); fireEvent.click(toggle);
  expect(p.onRefreshForConnection).toHaveBeenCalledTimes(1);
  resolve(fixture());
  await waitFor(() => expect(p.onMutate).toHaveBeenCalledTimes(1));
});

it("shows a safe error and preserves Off when refresh fails", async () => {
  const p = props(); p.onRefreshForConnection.mockRejectedValue(new Error("private internal error"));
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Hermes" }));
  await screen.findByText("Changes were not saved. Refresh and try again.");
  expect(screen.queryByText("private internal error")).not.toBeInTheDocument();
  expect(p.onMutate).not.toHaveBeenCalled();
  expect(screen.getByRole("switch", { name: "Enable Hermes" })).not.toBeChecked();
});
it("keeps native enable closed without a scoped refresh transport", () => {
  const p = props(); render(<AgentsProvidersView {...p} onRefreshForConnection={undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  expect(screen.getByRole("switch", { name: "Enable Hermes" })).toBeDisabled();
});
it("turns an enabled native harness Off without refreshing credentials", async () => {
  const p = props(); Object.assign(p.snapshot.harnesses[0]!, { enabled: true, configuredEnabled: true });
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Hermes" }));
  await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith({ type: "set_harness_enabled", harnessInstanceId: "hermes", enabled: false }));
  expect(p.onRefreshForConnection).not.toHaveBeenCalled();
});

it("rejects refresh completion after the Settings view unmounts", async () => {
  const p = props(); let resolve!: (snapshot: ProviderSettingsSnapshot) => void;
  p.onRefreshForConnection.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Hermes" }));
  view.unmount(); resolve(fixture());
  await new Promise(r => setTimeout(r, 0));
  expect(p.onMutate).not.toHaveBeenCalled();
});
it("rejects an old refresh when the visible route changes while it waits", async () => {
  const p = props(); let resolve!: (snapshot: ProviderSettingsSnapshot) => void;
  p.onRefreshForConnection.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Hermes" }));
  const changed = fixture(); changed.harnesses[0]!.route.modelId = "other";
  view.rerender(<AgentsProvidersView {...p} snapshot={changed} />);
  resolve(fixture());
  await screen.findByText("Changes were not saved. Refresh and try again.");
  expect(p.onMutate).not.toHaveBeenCalled();
});
