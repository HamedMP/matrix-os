// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isLocallyObservedNativeHarnessRoute, ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { useProviderSettingsController, type ProviderSettingsTransport } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { ChatProviderOnboarding } from "../../packages/ui/src/agents-providers/ChatProviderConnections";
import { hasStaleHermesConnection } from "../../packages/ui/src/agents-providers/harness-connection";
import { useLocalObservationExpiry } from "../../packages/ui/src/local-observation-expiry";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { disconnectedSnapshot } from "./chat-provider-settings-fixture";

function nativeSnapshot(remaining = 5000) {
  const value = disconnectedSnapshot();
  value.refreshedAt = new Date().toISOString();
  const observation = { state: "present_unverified" as const, checkedAt: new Date(Date.now() - 5000 + remaining).toISOString(), staleAfter: new Date(Date.now() + remaining).toISOString() };
  value.modelProviders = [{ id: "openai-codex", displayName: "OpenAI Codex", models: [{ id: "openai-codex:gpt-5.6-sol", displayName: "gpt-5.6-sol", enabled: true }] }];
  value.accessSources = [{ id: "native_hermes", kind: "harness_profile", harness: "hermes", providerId: "openai-codex", fundingKind: "owner_account", accountId: null,
    displayName: "Hermes account", eligibleModelIds: ["openai-codex:gpt-5.6-sol"],
    readiness: { state: "unknown", checkedAt: null, staleAfter: null, safeReason: "unknown", action: "retry" }, localObservation: observation,
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: observation.checkedAt } }];
  value.harnesses = [{ ...value.harnesses[0]!, id: "hermes_default", harness: "hermes", displayName: "Hermes", enabled: true, configuredEnabled: true,
    authState: "unknown", accessSourceId: "native_hermes", localObservation: observation,
    route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-sol" } }];
  return ProviderSettingsSnapshotSchema.parse(value);
}

function transport() {
  const getSnapshot = vi.fn(async (_signal: AbortSignal, options?: { refresh?: boolean }) => {
    if (options?.refresh) await new Promise((resolve) => setTimeout(resolve, 2000));
    return nativeSnapshot(2700);
  });
  return { getSnapshot, mutate: vi.fn() };
}
const openAction = vi.fn(async () => false);
const isIdentityCurrent = () => true;
function workflowClient(): ProviderWorkflowClient {
  return { capabilities: vi.fn().mockResolvedValue([]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() };
}
function Settings({ api, client }: { api: ProviderSettingsTransport; client?: ProviderWorkflowClient }) {
  const controller = useProviderSettingsController({ identityKey: "owner:runtime", transport: api });
  return controller.snapshot ? <AgentsProvidersView
    snapshot={controller.snapshot} selectedHarnessId={controller.selectedHarnessId}
    busy={controller.busy} error={controller.error} onSelectHarness={controller.onSelectHarness}
    onRefresh={controller.refresh} onRefreshForConnection={controller.refreshForConnection}
    onMutate={controller.mutate} onOpenTerminal={openAction} onOpenBrowser={openAction}
    workflowClient={client}
  /> : null;
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T03:20:00Z"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps stable Settings idle after a fresh short-TTL observation without requesting another snapshot", async () => {
  const api = transport();
  const onCatalogChanged = vi.fn();
  const options = { identityKey: "owner:runtime", transport: api, onCatalogChanged };
  const hook = renderHook(() => useProviderSettingsController(options));
  await act(async () => {});
  const refresh = hook.result.current.refresh;
  for (let index = 0; index < 20; index++) hook.rerender();
  expect(hook.result.current.refresh).toBe(refresh);
  await advance(1700);
  expect(hook.result.current.busy).toBe(false);
  await advance(58300);
  expect(api.getSnapshot).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { refresh: false });
  expect(onCatalogChanged).not.toHaveBeenCalled();
  expect(api.mutate).not.toHaveBeenCalled();
});

it("keeps the real expanded Settings view usable and capabilities stable for 60 seconds", async () => {
  const api = transport();
  const client = workflowClient();
  const view = render(<Settings api={api} client={client} />);
  await act(async () => {});
  const refresh = view.getByRole("button", { name: "Refresh provider status" });
  const row = view.getByRole("button", { name: /^Hermes.*Connected/ });
  fireEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "true");
  await advance(1700);
  expect(refresh).toBeEnabled();
  await advance(58300);
  expect(refresh).toBeEnabled();
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(api.getSnapshot).toHaveBeenCalledOnce();
  expect(client.capabilities).toHaveBeenCalledOnce();
  expect(client.start).not.toHaveBeenCalled();
  expect(api.mutate).not.toHaveBeenCalled();
});

it("expires local attempt evidence in the rendered UI while preserving historical Hermes recovery and canonical unknown auth", async () => {
  const api = transport();
  function ExpiryStatus() {
    const controller = useProviderSettingsController({ identityKey: "owner:runtime", transport: api });
    const snapshot = controller.snapshot;
    const source = snapshot?.accessSources[0];
    useLocalObservationExpiry([source?.localObservation?.staleAfter]);
    const harness = snapshot?.harnesses[0];
    return harness && source ? <output>{[
      isLocallyObservedNativeHarnessRoute(harness, source) ? "fresh attempt" : "expired attempt",
      hasStaleHermesConnection(harness, source) ? "historical recovery" : "fresh observation",
      harness.authState, source.readiness.state,
    ].join(" / ")}</output> : null;
  }
  const view = render(<ExpiryStatus />);
  await act(async () => {});
  expect(view.getByRole("status")).toHaveTextContent("fresh attempt / fresh observation / unknown / unknown");
  await advance(2701);
  expect(view.getByRole("status")).toHaveTextContent("expired attempt / historical recovery / unknown / unknown");
  expect(api.getSnapshot).toHaveBeenCalledOnce();
  expect(api.mutate).not.toHaveBeenCalled();
});

it("does not run a second TTL poller in retained hidden actual Chat onboarding", async () => {
  const settings = transport();
  const chat = transport();
  const view = render(<><Settings api={settings} /><div hidden>
    <ChatProviderOnboarding identityKey="owner:runtime" transport={chat}
      isIdentityCurrent={isIdentityCurrent} openAction={openAction} lifecycleRefresh={false}>
      <span>Retained Chat starter</span>
    </ChatProviderOnboarding>
  </div></>);
  await act(async () => {});
  await advance(60000);
  expect(settings.getSnapshot).toHaveBeenCalledOnce();
  expect(chat.getSnapshot).toHaveBeenCalledOnce();
  expect(view.getByText("Retained Chat starter")).toBeInTheDocument();
  expect(settings.mutate).not.toHaveBeenCalled();
  expect(chat.mutate).not.toHaveBeenCalled();
});

it("performs one explicit Refresh with temporary busy and capability revalidation, without restarting idle polling", async () => {
  const api = transport();
  const client = workflowClient();
  const view = render(<Settings api={api} client={client} />);
  await act(async () => {});
  const refresh = view.getByRole("button", { name: "Refresh provider status" });
  fireEvent.click(refresh);
  expect(refresh).toBeDisabled();
  expect(api.getSnapshot).toHaveBeenLastCalledWith(expect.any(AbortSignal), { refresh: true });
  await advance(2000);
  expect(refresh).toBeEnabled();
  expect(client.capabilities).toHaveBeenCalledTimes(2);
  await advance(60000);
  expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  expect(client.capabilities).toHaveBeenCalledTimes(2);
  expect(api.mutate).not.toHaveBeenCalled();
});

it("retains the loaded snapshot and safe error when an explicit Refresh fails, without background retry", async () => {
  const api = transport();
  const view = render(<Settings api={api} />);
  await act(async () => {});
  api.getSnapshot.mockRejectedValueOnce(new Error("private upstream/path"));
  fireEvent.click(view.getByRole("button", { name: "Refresh provider status" }));
  await act(async () => {});
  expect(view.getByRole("alert")).not.toHaveTextContent("private upstream/path");
  expect(view.getByRole("button", { name: "Refresh provider status" })).toBeEnabled();
  expect(view.getByRole("heading", { name: "Agents & providers" })).toBeVisible();
  await advance(60000);
  expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  expect(api.mutate).not.toHaveBeenCalled();
});
