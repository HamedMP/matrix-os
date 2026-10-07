// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { useProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { disconnectedSnapshot } from "./chat-provider-settings-fixture";

function nativeSnapshot(remaining = 5000) {
  const value = disconnectedSnapshot();
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
async function mount(getSnapshot = vi.fn(async () => nativeSnapshot(2700))) {
  const onCatalogChanged = vi.fn();
  const options = { identityKey: "owner:runtime", transport: { getSnapshot, mutate: vi.fn() }, onCatalogChanged };
  const hook = renderHook(() => useProviderSettingsController(options));
  await act(async () => {});
  return { ...hook, getSnapshot, onCatalogChanged };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("renews from remaining TTL while mounted without invalidating Chat catalogs each time", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  const hook = await mount();
  expect(hook.getSnapshot).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1699); });
  expect(hook.getSnapshot).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(hook.getSnapshot).toHaveBeenCalledTimes(2);
  expect(hook.onCatalogChanged).not.toHaveBeenCalled();
  hook.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(hook.getSnapshot).toHaveBeenCalledTimes(2);
});

it("bounds failed renewal and does not renew absent or actually expired credentials", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  const getSnapshot = vi.fn().mockResolvedValueOnce(nativeSnapshot()).mockRejectedValue(new Error("offline"));
  const hook = await mount(getSnapshot);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(getSnapshot).toHaveBeenCalledTimes(4);
  hook.unmount();
  const negative = nativeSnapshot(); negative.harnesses[0]!.authState = "expired";
  const other = await mount(vi.fn(async () => negative));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(other.getSnapshot).toHaveBeenCalledOnce(); other.unmount();
});

it("pauses while hidden and aborts a renewal on hide or unmount", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  let renewSignal: AbortSignal | undefined;
  const getSnapshot = vi.fn().mockResolvedValueOnce(nativeSnapshot()).mockImplementation((signal: AbortSignal) => {
    renewSignal = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  const hook = await mount(getSnapshot);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(getSnapshot).toHaveBeenCalledOnce();
  visibility.mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(1000); });
  expect(getSnapshot).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(renewSignal?.aborted).toBe(true);
  hook.unmount();
});

it("suspends retained inactive panes and aborts when the pane becomes inactive", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  let pendingSignal: AbortSignal | undefined;
  const getSnapshot = vi.fn().mockResolvedValueOnce(nativeSnapshot()).mockImplementation((signal: AbortSignal) => {
    pendingSignal = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  const options = { identityKey: "owner:retained", transport: { getSnapshot, mutate: vi.fn() } };
  const hook = renderHook(({ active }) => useProviderSettingsController({ ...options, observationRenewalActive: active }), { initialProps: { active: false } });
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(getSnapshot).toHaveBeenCalledOnce();
  hook.rerender({ active: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(getSnapshot).toHaveBeenCalledTimes(2);
  hook.rerender({ active: false });
  expect(pendingSignal?.aborted).toBe(true);
  hook.unmount();
});

it("stops after three accepted responses that still contain expired observations", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  const stale = nativeSnapshot();
  const getSnapshot = vi.fn(async () => ({ ...stale }));
  const hook = await mount(getSnapshot);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(getSnapshot).toHaveBeenCalledTimes(4);
  hook.unmount();
});
