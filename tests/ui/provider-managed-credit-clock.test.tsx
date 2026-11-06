// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { ProviderSettingsController, useProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { gatewayChatAvailableMicrousd, gatewayCreditLines, gatewayCreditStaleAfter } from "../../packages/ui/src/agents-providers/utils";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Signed age is client time minus the original server observation time.
const boundaries = [
  { age: -2_650, accepted: true },
  { age: -60_000, accepted: true },
  { age: -60_001, accepted: false },
  { age: 0, accepted: true },
  { age: 300_000, accepted: true },
  { age: 300_001, accepted: false },
];

it.each(boundaries)("derives credit at signed age $age ms (accepted: $accepted)", ({ age, accepted }) => {
  const source = snapshot().accessSources[0]!;
  const asOf = source.usage.asOf;
  vi.setSystemTime(Date.parse(start) + age);
  expect(gatewayChatAvailableMicrousd(source)).toBe(accepted ? 4_000_000 : null);
  expect(gatewayCreditLines(source)).toEqual({ primary: accepted ? "$4.00" : "Chat credit unavailable", secondary: null, stale: !accepted });
  expect(source.usage.asOf).toBe(asOf);
  expect(gatewayCreditStaleAfter(source)).toBe(new Date(Date.parse(start) + 300_000).toISOString());
});

// Policy validity is capped at five minutes and expires at equality; the credit
// age itself remains inclusive there, as the display cases above establish.
it.each(boundaries.map(boundary => ({ ...boundary, accepted: boundary.accepted && boundary.age < 300_000 })))("quiet controller refresh respects signed age $age ms (accepted: $accepted)", async ({ age, accepted }) => {
  const original = snapshot();
  // Keep the new observation monotonic, independently of its age at this client.
  const originalUsage = original.accessSources[0]!.usage;
  if (originalUsage.kind !== "managed_credit") throw new Error("Expected credit fixture");
  originalUsage.asOf = originalUsage.chatAvailability!.asOf = new Date(Date.parse(start) - 1).toISOString();
  const next = observation(3_000_000);
  next.policy.staleAfter = new Date(Date.parse(start) + 300_000).toISOString();
  const getSnapshot = vi.fn().mockResolvedValue(original);
  const getManagedCredit = vi.fn().mockResolvedValue(next);
  const onCatalogChanged = vi.fn();
  const controller = new ProviderSettingsController({ identityKey: "owner/runtime", transport: { getSnapshot, getManagedCredit, mutate: vi.fn() }, onCatalogChanged });
  await controller.refresh({ refresh: false });
  const before = controller.getState().snapshot!;
  vi.setSystemTime(Date.parse(start) + age);
  expect(await controller.refreshManagedCredit()).toBe(accepted ? "updated" : "retry");
  const after = controller.getState();
  if (accepted) {
    expect(after.snapshot!.accessSources[0]!.usage).toEqual(next.usage);
    expect(after.snapshot!.refreshedAt).toBe(before.refreshedAt);
    expect(after.snapshot!.harnesses).toBe(before.harnesses);
    expect(after.snapshot!.accounts).toBe(before.accounts);
    expect(after.snapshot!.accessSources[0]!.readiness).toBe(before.accessSources[0]!.readiness);
  } else expect(after.snapshot).toBe(before);
  expect(after.busy).toBe(false);
  expect(after.error).toBeNull();
  expect(getSnapshot).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { refresh: false });
  expect(getManagedCredit).toHaveBeenCalledOnce();
  expect(onCatalogChanged).not.toHaveBeenCalled();
  controller.dispose();
});

it.each(["invalid", "mismatched", "stale"] as const)("keeps %s usage unavailable inside the clock tolerance", kind => {
  const source = snapshot().accessSources[0]!;
  if (source.usage.kind !== "managed_credit") throw new Error("Expected credit fixture");
  if (kind === "invalid") source.usage.asOf = "not-a-date";
  if (kind === "mismatched") source.usage.chatAvailability!.asOf = new Date(Date.parse(start) - 1).toISOString();
  if (kind === "stale") source.usage.state = "stale";
  vi.setSystemTime(Date.parse(start) - 2_650);
  expect(gatewayChatAvailableMicrousd(source)).toBeNull();
  expect(gatewayCreditLines(source).primary).toBe("Chat credit unavailable");
});

it("retains the independent policy expiry fence for otherwise current credit", async () => {
  const original = snapshot();
  const next = observation();
  vi.setSystemTime(Date.parse(start) + 45_000);
  next.policy.staleAfter = new Date().toISOString();
  const getManagedCredit = vi.fn().mockResolvedValue(next);
  const controller = new ProviderSettingsController({ identityKey: "owner/runtime", transport: {
    getSnapshot: vi.fn().mockResolvedValue(original), getManagedCredit, mutate: vi.fn(),
  } });
  await controller.refresh({ refresh: false });
  const before = controller.getState().snapshot;
  expect(await controller.refreshManagedCredit()).toBe("retry");
  expect(controller.getState().snapshot).toBe(before);
  expect(getManagedCredit).toHaveBeenCalledOnce();
  controller.dispose();
});

it("expires the mounted skew-tolerant amount at the original server deadline without requests", async () => {
  const original = snapshot();
  const onRefresh = vi.fn();
  const onMutate = vi.fn();
  vi.setSystemTime(Date.parse(start) - 2_650);
  render(<AgentsProvidersView snapshot={original} selectedHarnessId={original.harnesses[0]!.id}
    onSelectHarness={vi.fn()} onRefresh={onRefresh} onMutate={onMutate} />);
  expect(screen.getByText("$4.00")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(302_650); });
  expect(screen.getByText("$4.00")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(onRefresh).not.toHaveBeenCalled();
  expect(onMutate).not.toHaveBeenCalled();
  expect(original.accessSources[0]!.usage.asOf).toBe(start);
});

it("renews the mounted skewed view with one quiet read and no full discovery", async () => {
  const original = snapshot();
  const getSnapshot = vi.fn().mockResolvedValue(original);
  const getManagedCredit = vi.fn().mockImplementation(async () => {
    const next = observation(3_000_000);
    const serverTime = Date.now() + 2_650;
    next.usage.asOf = next.usage.chatAvailability!.asOf = next.policy.checkedAt = new Date(serverTime).toISOString();
    next.policy.staleAfter = new Date(serverTime + 60_000).toISOString();
    return next;
  });
  const transport = { getSnapshot, getManagedCredit, mutate: vi.fn() };
  vi.setSystemTime(Date.parse(start) - 2_650);
  function Settings() {
    const state = useProviderSettingsController({ identityKey: "owner/runtime", transport, automaticCreditRefreshEnabled: true });
    return state.snapshot ? <AgentsProvidersView snapshot={state.snapshot} selectedHarnessId={state.selectedHarnessId}
      onSelectHarness={state.onSelectHarness} onRefresh={() => void state.refresh()} onMutate={state.mutate} /> : null;
  }
  render(<Settings />);
  await act(async () => {});
  expect(screen.getByText("$4.00")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(screen.getByText("$3.00")).toBeVisible();
  expect(screen.queryByText("Chat credit unavailable")).not.toBeInTheDocument();
  expect(getManagedCredit).toHaveBeenCalledOnce();
  expect(getSnapshot).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { refresh: false });
  expect(transport.mutate).not.toHaveBeenCalled();
});
