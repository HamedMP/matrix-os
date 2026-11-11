import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderManagedCreditObservation, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { ProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); });
function setup() {
  const initial = snapshot();
  let incoming = structuredClone(initial);
  const transport = { getSnapshot: vi.fn(async () => structuredClone(incoming)), getManagedCredit: vi.fn(async () => observation(3000000)), mutate: vi.fn() };
  const owner = new ProviderSettingsController({ identityKey: "owner/main", transport });
  return { owner, transport, initial, setIncoming: (next: ProviderSettingsSnapshot) => { incoming = next; } };
}
function remaining(value: ProviderSettingsSnapshot | null) { const usage = value?.accessSources[0]?.usage; return usage?.kind === "managed_credit" ? usage.remainingMicrousd : null; }
it("keeps a fresher independently verified credit observation across ordinary native snapshots", async () => {
  const { owner, initial } = setup();
  try {
    await owner.refresh({ refresh: false });
    vi.advanceTimersByTime(45000);
    expect(await owner.refreshManagedCredit()).toBe("updated");
    expect(remaining(owner.getState().snapshot)).toBe(3000000);
    await owner.refreshNativeAuthentication(new AbortController().signal);
    expect(remaining(owner.getState().snapshot)).toBe(3000000);
    expect(initial.accessSources[0]!.usage).not.toEqual(owner.getState().snapshot!.accessSources[0]!.usage);
  }
  finally {
    owner.dispose();
  }
});
it("does not block or invalidate an in-flight credit read when native status reconciles", async () => {
  const { owner, transport } = setup();
  let release!: (value: ProviderManagedCreditObservation) => void;
  try {
    await owner.refresh({ refresh: false });
    vi.advanceTimersByTime(45000);
    transport.getManagedCredit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = owner.refreshManagedCredit();
    await Promise.resolve();
    await owner.refreshNativeAuthentication(new AbortController().signal);
    expect(owner.getState().busy).toBe(false);
    release(observation(2000000));
    expect(await pending).toBe("updated");
    expect(remaining(owner.getState().snapshot)).toBe(2000000);
  }
  finally {
    owner.dispose();
  }
});
it.each(["revision", "gateway", "eligible_models"])("rejects an in-flight credit result after native status changes its %s authority", async (change) => {
  const { owner, transport, initial, setIncoming } = setup();
  let release!: (value: ProviderManagedCreditObservation) => void;
  try {
    await owner.refresh({ refresh: false });
    vi.advanceTimersByTime(45000);
    transport.getManagedCredit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = owner.refreshManagedCredit();
    await Promise.resolve();
    const next = structuredClone(initial);
    if (change === "revision")
      next.revision++;
    if (change === "gateway")
      next.gatewayPolicy = null;
    if (change === "eligible_models") {
      next.modelProviders[0]!.models.push({ ...next.modelProviders[0]!.models[0]!, id: "opus" });
      next.accessSources[0]!.eligibleModelIds.push("opus");
    }
    setIncoming(next);
    await owner.refreshNativeAuthentication(new AbortController().signal);
    release(observation(2000000));
    expect(await pending).not.toBe("updated");
    expect(remaining(owner.getState().snapshot)).toBe(4000000);
  }
  finally {
    owner.dispose();
  }
});
it("does not copy cached credit over a newer full-snapshot observation or changed policy", async () => {
  const { owner, initial, setIncoming } = setup();
  try {
    await owner.refresh({ refresh: false });
    vi.advanceTimersByTime(45000);
    await owner.refreshManagedCredit();
    vi.advanceTimersByTime(1000);
    const next = structuredClone(initial);
    next.accessSources[0]!.usage = observation(1000000).usage;
    setIncoming(next);
    await owner.refreshNativeAuthentication(new AbortController().signal);
    expect(remaining(owner.getState().snapshot)).toBe(1000000);
    const changed = structuredClone(initial);
    changed.gatewayPolicy!.monthlyBudgetMicrousd = 2000000;
    setIncoming(changed);
    await owner.refreshNativeAuthentication(new AbortController().signal);
    expect(owner.getState().snapshot!.gatewayPolicy!.monthlyBudgetMicrousd).toBe(2000000);
  }
  finally {
    owner.dispose();
  }
});
it("does not let an obsolete native response evict newer independently verified credit", async () => {
  const { owner, transport, initial } = setup();
  let release!: (value: ProviderSettingsSnapshot) => void;
  try {
    await owner.refresh({ refresh: false });
    transport.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = owner.refreshNativeAuthentication(new AbortController().signal);
    await owner.refresh({ refresh: false });
    vi.advanceTimersByTime(45000);
    await owner.refreshManagedCredit();
    const obsolete = structuredClone(initial);
    obsolete.gatewayPolicy!.monthlyBudgetMicrousd = 2000000;
    release(obsolete);
    await pending;
    expect(remaining(owner.getState().snapshot)).toBe(3000000);
    await owner.refreshNativeAuthentication(new AbortController().signal);
    expect(remaining(owner.getState().snapshot)).toBe(3000000);
  }
  finally {
    owner.dispose();
  }
});
