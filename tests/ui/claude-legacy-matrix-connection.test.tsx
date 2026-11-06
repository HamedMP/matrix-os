// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {ProviderSettingsSnapshotSchema, type ProviderSettingsSnapshot} from "@matrix-os/contracts";
import {AgentsProvidersView} from "../../packages/ui/src/agents-providers/AgentsProvidersView.js";
import type {ProviderWorkflowClient} from "../../packages/ui/src/agents-providers/types.js";
import nativeInput from "../fixtures/claude-native-authenticated-off.json";

afterEach(() => {cleanup(); vi.useRealTimers();});
const option = {id: "anthropic_browser", providerId: "anthropic", authKind: "subscription", method: "browser", billingKind: "subscription", executionKind: "native", availability: "available"} as const;
function fixture(): ProviderSettingsSnapshot {
  const snapshot = ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));
  snapshot.refreshedAt = new Date().toISOString();
  snapshot.accounts[0]!.lastCheckedAt = snapshot.refreshedAt;
  Object.assign(snapshot.harnesses[0]!, {id: "harness_kernel", enabled: false, configuredEnabled: true,
    authState: "unknown", selectedAccountId: null, accessSourceId: null, configuredAccessSourceId: "matrix_included"});
  delete snapshot.harnesses[0]!.enablementOrigin;
  return snapshot;
}
function mount(snapshot = fixture(), fail = false, resuming = false) {
  const harness = snapshot.harnesses[0]!;
  const onMutate = vi.fn(), onRefresh = vi.fn(), onRefreshForConnection = vi.fn(async () => snapshot);
  const operation = {id: "adopt-native", harnessInstanceId: harness.id, kind: "login", state: "succeeded", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deviceCode: null, authorizationUrl: null, terminalSessionId: null, safeFailure: null, connectionOption: option} as const;
  const startConnection = fail ? vi.fn().mockRejectedValue(new Error("synthetic completion unavailable")) : vi.fn(async () => operation);
  const client: ProviderWorkflowClient = {capabilities: vi.fn(async () => [{harnessInstanceId: harness.id, harness: "claude", displayName: "Claude Code", installState: "installed",
    loginMethods: ["browser"], apiKeyProviders: [], connectionOptions: [option], install: false, uninstall: false, logs: false,
    ...(resuming ? {activeOperationId: "resuming-native"} : {})}]),
    startConnection, start: vi.fn(), get: resuming ? vi.fn(() => new Promise(() => {})) : vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn()};
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={harness.id} onSelectHarness={vi.fn()}
    onRefresh={onRefresh} onRefreshForConnection={onRefreshForConnection} onMutate={onMutate} workflowClient={client}
    onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", {name: /^Claude Code/}));
  return {client, startConnection, onMutate, onRefreshForConnection};
}
it.each([true, false])("shows verified native authentication on an unmarked Matrix-bound legacy row without changing configuredEnabled=%s or its execution source", async enabled => {
  const snapshot = fixture(); snapshot.harnesses[0]!.configuredEnabled = enabled;
  const before = structuredClone(snapshot);
  const controls = mount(snapshot);
  expect(await screen.findByRole("button", {name: "Use connected Claude account"})).toBeEnabled();
  expect(screen.getByRole("button", {name: /Claude Code.*Connected/})).toBeVisible();
  expect(screen.getByText(/Uses your Claude subscription; Matrix AI credit is separate/)).toBeVisible();
  expect(snapshot).toEqual(before);
  expect(controls.onMutate).not.toHaveBeenCalled();
  expect(controls.startConnection).not.toHaveBeenCalled();
});
it("uses the qualified existing native workflow only after an explicit adoption click", async () => {
  const snapshot = fixture(), before = structuredClone(snapshot);
  const controls = mount(snapshot);
  fireEvent.click(await screen.findByRole("button", {name: "Use connected Claude account"}));
  await waitFor(() => expect(controls.startConnection).toHaveBeenCalledWith({harnessInstanceId: "harness_kernel", optionId: option.id, idempotencyKey: expect.any(String)}, expect.any(AbortSignal)));
  await waitFor(() => expect(controls.onRefreshForConnection).toHaveBeenCalled());
  expect(controls.client.start).not.toHaveBeenCalled();
  expect(controls.onMutate).not.toHaveBeenCalled();
  expect(snapshot).toEqual(before);
});
it("retains the legacy route and allows retry after adoption fails", async () => {
  const snapshot = fixture(), before = structuredClone(snapshot);
  const controls = mount(snapshot, true);
  fireEvent.click(await screen.findByRole("button", {name: "Use connected Claude account"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("The connection could not be updated. Try again.");
  expect(screen.getByRole("button", {name: "Use connected Claude account"})).toBeEnabled();
  expect(snapshot).toEqual(before);
  expect(controls.onMutate).not.toHaveBeenCalled();
});
it("waits for an existing operation to resume before offering another adoption start", async () => {
  const controls = mount(fixture(), false, true);
  const adopt = await screen.findByRole("button", {name: "Use connected Claude account"});
  await waitFor(() => expect(controls.client.get).toHaveBeenCalledWith("resuming-native", expect.any(AbortSignal)));
  expect(adopt).toBeDisabled();
  fireEvent.click(adopt);
  expect(controls.startConnection).not.toHaveBeenCalled();
});
it("removes the legacy recovery action when native authentication expires without a new snapshot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
  const snapshot = fixture(), before = structuredClone(snapshot);
  mount(snapshot);
  await act(async () => {});
  expect(screen.getByRole("button", {name: "Use connected Claude account"})).toBeEnabled();
  await act(async () => {await vi.advanceTimersByTimeAsync(30_001);});
  expect(screen.queryByRole("button", {name: "Use connected Claude account"})).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: /Claude Code.*Not connected/})).toBeVisible();
  expect(snapshot).toEqual(before);
});
const negatives: [string, (snapshot: ProviderSettingsSnapshot) => void][] = [
  ["saved email without authentication", s => {s.accounts[0]!.authState = "unknown";}],
  ["stale native authentication", s => {s.accounts[0]!.lastCheckedAt = new Date(Date.now() - 30_001).toISOString();}],
  ["future native authentication", s => {s.accounts[0]!.lastCheckedAt = new Date(Date.now() + 60_000).toISOString();}],
  ["missing native driver", s => {s.harnesses[0]!.installState = "missing";}],
  ["explicit owner route", s => {s.harnesses[0]!.enablementOrigin = "owner_configuration";}],
  ["another saved source", s => {s.harnesses[0]!.configuredAccessSourceId = "owner_anthropic_key";}],
  ["another account source", s => {s.accounts[0]!.accessSourceId = "other_source";}],
  ["another provider", s => {s.accounts[0]!.providerId = "openai";}],
  ["API-key authentication", s => {s.accounts[0]!.authMethod = "api_key";}],
  ["mismatched source account", s => {s.accessSources[0]!.accountId = "other_account";}],
  ["an account not associated with the harness", s => {s.harnesses[0]!.accountIds = [];}],
  ["a nonnative funding source", s => {s.accessSources[0]!.fundingKind = "owner_api_key";}],
  ["negative native readiness", s => {s.accessSources[0]!.readiness.state = "invalid";}],
];
it.each(negatives)("preserves exact identity and explicit recovery fences for %s", async (_name, change) => {
  const snapshot = fixture(); change(snapshot); const before = structuredClone(snapshot);
  const controls = mount(snapshot);
  await waitFor(() => expect(controls.client.capabilities).toHaveBeenCalled());
  expect(screen.queryByRole("button", {name: "Use connected Claude account"})).not.toBeInTheDocument();
  if (_name === "explicit owner route" || _name === "another saved source") {
    expect(screen.getByRole("button", {name: /^Claude Code/})).toHaveTextContent("Connected");
  } else {
    expect(screen.getByRole("button", {name: /^Claude Code/})).not.toHaveTextContent("Connected");
  }
  expect(snapshot).toEqual(before);
});
