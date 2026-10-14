// @vitest-environment jsdom
import React, { useLayoutEffect } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettingsController, ProviderSettingsTransportError, useProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { gatewayChatAvailableMicrousd } from "../../packages/ui/src/agents-providers/utils";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";
import { ProviderSettingsSnapshotSchema, type ProviderManagedCreditObservation } from "@matrix-os/contracts";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup() {
  const original = snapshot();
  const getSnapshot = vi.fn().mockResolvedValue(original);
  const getManagedCredit = vi.fn().mockImplementation(async () => observation());
  const onCatalogChanged = vi.fn();
  const transport = { getSnapshot, getManagedCredit, mutate: vi.fn() };
  const controller = new ProviderSettingsController({ identityKey: "owner/runtime", transport, onCatalogChanged });
  return { original, transport, getSnapshot, getManagedCredit, onCatalogChanged, controller };
}
it("quietly replaces only authoritative credit and budget, without discovery callbacks or busy", async () => {
  const t = setup(); await t.controller.refresh({ refresh: false });
  const before = t.controller.getState().snapshot!;
  vi.setSystemTime(Date.now() + 45_000);
  t.getManagedCredit.mockResolvedValue(observation(3_000_000));
  expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const next = t.controller.getState();
  expect(next.busy).toBe(false); expect(next.error).toBeNull();
  expect(next.snapshot?.refreshedAt).toBe(t.original.refreshedAt);
  expect(next.snapshot?.harnesses).toBe(before.harnesses);
  expect(next.snapshot?.accounts).toBe(before.accounts);
  expect(next.snapshot?.accessSources[0]?.usage).toEqual(observation(3_000_000).usage);
  expect(t.getSnapshot).toHaveBeenCalledTimes(1); expect(t.onCatalogChanged).not.toHaveBeenCalled();
});
it("visible Settings renews changing credit beyond five minutes; hidden Chat does not opt in", async () => {
  const t = setup(); let balance = 4_000_000;
  t.getManagedCredit.mockImplementation(async () => observation(balance -= 10_000));
  const view = renderHook(() => useProviderSettingsController({ identityKey: "owner/runtime", transport: t.transport, automaticCreditRefreshEnabled: true }));
  await act(async () => {});
  for (let index = 0; index < 8; index++) await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(t.getManagedCredit).toHaveBeenCalledTimes(8);
  expect(view.result.current.snapshot?.accessSources[0]?.usage.asOf).toBe(new Date().toISOString());
  expect(view.result.current.busy).toBe(false); expect(t.getSnapshot).toHaveBeenCalledTimes(1);
  view.unmount();
  const chat = setup(); renderHook(() => useProviderSettingsController({ identityKey: "chat", transport: chat.transport }));
  await act(async () => { await vi.advanceTimersByTimeAsync(360_000); });
  expect(chat.getManagedCredit).not.toHaveBeenCalled(); expect(chat.getSnapshot).toHaveBeenCalledTimes(1);
});
it("narrows disabled/revoked policy without corrupting configured routes or reviving readiness", async () => {
  const t = setup(); await t.controller.refresh({ refresh: false }); vi.setSystemTime(Date.now() + 45_000);
  const revoked = observation(); revoked.policy.enabled = false; revoked.policy.allowedModelIds = [];
  t.getManagedCredit.mockResolvedValue(revoked);
  expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const next = t.controller.getState().snapshot!;
  expect(next.accessSources[0]?.readiness.state).toBe("unavailable");
  expect(ProviderSettingsSnapshotSchema.safeParse(next).success).toBe(true);
  vi.setSystemTime(Date.now() + 45_000); t.getManagedCredit.mockResolvedValue(observation());
  await t.controller.refreshManagedCredit();
  expect(t.controller.getState().snapshot?.accessSources[0]?.readiness.state).toBe("unavailable");
});
it("stops unsupported/auth requests per identity without full-read fallback", async () => {
  for (const code of ["managed_credit_unsupported", "managed_credit_unauthorized"] as const) {
    const t = setup(); await t.controller.refresh({ refresh: false });
    t.getManagedCredit.mockRejectedValue(new ProviderSettingsTransportError(code));
    expect(await t.controller.refreshManagedCredit()).toBe("unsupported");
    expect(await t.controller.refreshManagedCredit()).toBe("unsupported");
    expect(t.getManagedCredit).toHaveBeenCalledTimes(1); expect(t.getSnapshot).toHaveBeenCalledTimes(1);
    expect(t.controller.getState().error).toBeNull();
  }
});

it("retains a real view's budget draft/disclosure and fresh display through committed quiet replacement", async () => {
  const t = setup(); t.original.supportedActions.push("set_gateway_budget");
  const workflow: ProviderWorkflowClient = { capabilities: vi.fn().mockResolvedValue([]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() };
  const frames: string[] = [];
  function Settings() {
    const state = useProviderSettingsController({ identityKey: "view", transport: t.transport, automaticCreditRefreshEnabled: true });
    useLayoutEffect(() => { if (state.snapshot) frames.push(document.body.textContent ?? ""); }, [state.snapshot]);
    return state.snapshot ? <AgentsProvidersView workflowClient={workflow} snapshot={state.snapshot} selectedHarnessId={state.selectedHarnessId} busy={state.busy} onSelectHarness={state.onSelectHarness} onRefresh={() => void state.refresh()} onMutate={state.mutate} /> : null;
  }
  render(<Settings />); await act(async () => {});
  fireEvent.click(screen.getByText("Advanced Matrix AI settings"));
  const input = screen.getByRole("textbox", { name: "Monthly budget in USD" });
  fireEvent.change(input, { target: { value: "17" } });
  const row = screen.getByRole("button", { name: /^Claude Code/ }); fireEvent.click(row);
  frames.length = 0;
  t.getManagedCredit.mockImplementation(async () => {
    const next = observation(3_000_000); next.policy.monthlyBudgetMicrousd = 6_000_000;
    next.usage.limitMicrousd = 6_000_000; next.usage.budget.monthlyBudgetMicrousd = 6_000_000;
    next.usage.budget.remainingBudgetMicrousd = 4_000_000; return next;
  });
  for (let index = 0; index < 8; index++) await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(screen.getByText("$3.00")).toBeVisible();
  expect.soft(frames.some(text => text.includes("Chat credit unavailable"))).toBe(false);
  expect(screen.getByRole("textbox", { name: "Monthly budget in USD" })).toBe(input);
  expect(input).toHaveValue("17"); expect(row).toHaveAttribute("aria-expanded", "true");
  expect(workflow.capabilities).toHaveBeenCalledOnce();
  for (const method of [workflow.start, workflow.get, workflow.cancel, workflow.submitKey, workflow.logs]) expect(method).not.toHaveBeenCalled();
  expect(t.getSnapshot).toHaveBeenCalledTimes(1);
});

it("preserves timestamps through failures and bounded backoff until conservative expiry", async () => {
  const t = setup(); t.getManagedCredit.mockRejectedValue(new Error("network"));
  const view = renderHook(() => useProviderSettingsController({ identityKey: "failures", transport: t.transport, automaticCreditRefreshEnabled: true }));
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); }); expect(t.getManagedCredit).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); expect(t.getManagedCredit).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(t.getManagedCredit).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(t.getManagedCredit).toHaveBeenCalledTimes(4);
  await act(async () => { await vi.advanceTimersByTimeAsync(151_000); });
  const source = view.result.current.snapshot!.accessSources[0]!;
  expect(source.usage.asOf).toBe(start); expect(gatewayChatAvailableMicrousd(source)).toBeNull();
  expect(view.result.current.error).toBeNull(); expect(view.result.current.busy).toBe(false);
  t.getManagedCredit.mockImplementation(async () => observation(2_000_000));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(gatewayChatAvailableMicrousd(view.result.current.snapshot!.accessSources[0]!)).toBe(2_000_000);
  expect(t.getSnapshot).toHaveBeenCalledTimes(1);
});
it("does not pin a settled single-flight when the transport throws synchronously", async () => {
  const t = setup(); await t.controller.refresh({ refresh: false });
  t.getManagedCredit.mockImplementationOnce(() => { throw new Error("sync"); });
  expect(await t.controller.refreshManagedCredit()).toBe("retry");
  vi.setSystemTime(Date.now() + 45_000);
  expect(await t.controller.refreshManagedCredit()).toBe("updated"); expect(t.getManagedCredit).toHaveBeenCalledTimes(2);
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it("joins slow reads and ignores completions after manual refresh, mutation or disposal", async () => {
  for (const invalidation of ["refresh", "mutation", "dispose"] as const) {
    const t = setup(); await t.controller.refresh({ refresh: false });
    const pending = deferred<ProviderManagedCreditObservation>(); t.getManagedCredit.mockReturnValue(pending.promise);
    const first = t.controller.refreshManagedCredit(); const joined = t.controller.refreshManagedCredit();
    expect(joined).toBe(first); await Promise.resolve(); expect(t.getManagedCredit).toHaveBeenCalledTimes(1);
    const signal = t.getManagedCredit.mock.calls[0]![0] as AbortSignal;
    if (invalidation === "refresh") await t.controller.refresh({ refresh: false });
    else if (invalidation === "mutation") await t.controller.mutate({ type: "set_harness_enabled", harnessInstanceId: "claude_default", enabled: true });
    else t.controller.dispose();
    expect(signal.aborted).toBe(true); const before = t.controller.getState().snapshot;
    pending.resolve(observation(1_000_000)); expect(await first).toBe("aborted");
    expect(t.controller.getState().snapshot).toBe(before);
  }
});
it.each(["revision", "source", "older", "future", "mismatched", "expired"])("rejects %s observations without restamping", async kind => {
  const t = setup(); await t.controller.refresh({ refresh: false }); const before = t.controller.getState().snapshot;
  vi.setSystemTime(Date.now() + 45_000); const next = observation();
  if (kind === "revision") next.revision++;
  if (kind === "source") next.gatewayPolicyAccessSourceId = "other";
  if (kind === "older") next.usage.asOf = next.policy.checkedAt = next.usage.chatAvailability!.asOf = new Date(Date.parse(start) - 1).toISOString();
  if (kind === "future") next.usage.asOf = next.policy.checkedAt = next.usage.chatAvailability!.asOf = new Date(Date.now() + 1).toISOString();
  if (kind === "mismatched") next.usage.chatAvailability!.asOf = start;
  if (kind === "expired") next.policy.staleAfter = new Date(Date.now()).toISOString();
  t.getManagedCredit.mockResolvedValue(next); expect(await t.controller.refreshManagedCredit()).toBe("retry");
  expect(t.controller.getState().snapshot).toBe(before);
});

it("coalesces overdue visibility/focus/online bursts and ignores non-due focus", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const t = setup(); const view = renderHook(({ enabled }) => useProviderSettingsController({ identityKey: "visibility", transport: t.transport, automaticCreditRefreshEnabled: enabled }), { initialProps: { enabled: true } });
  await act(async () => {});
  await act(async () => { window.dispatchEvent(new Event("focus")); }); expect(t.getManagedCredit).not.toHaveBeenCalled();
  visibility.mockReturnValue("hidden"); online.mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("offline")); await vi.advanceTimersByTimeAsync(360_000); });
  expect(t.getManagedCredit).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible"); online.mockReturnValue(true);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  expect(t.getManagedCredit).toHaveBeenCalledTimes(1);
  view.rerender({ enabled: false }); await act(async () => { await vi.advanceTimersByTimeAsync(360_000); }); expect(t.getManagedCredit).toHaveBeenCalledTimes(1);
  view.rerender({ enabled: true }); await act(async () => {}); expect(t.getManagedCredit).toHaveBeenCalledTimes(2);
  view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(360_000); }); expect(t.getManagedCredit).toHaveBeenCalledTimes(2);
});
it("StrictMode and slow reads preserve one automatic request; unmount aborts its owned work", async () => {
  const t = setup(); const pending = deferred<ProviderManagedCreditObservation>(); t.getManagedCredit.mockReturnValue(pending.promise);
  const view = renderHook(() => useProviderSettingsController({ identityKey: "strict", transport: t.transport, automaticCreditRefreshEnabled: true }), { reactStrictMode: true });
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  expect(t.getManagedCredit).toHaveBeenCalledTimes(1); expect(t.getSnapshot).toHaveBeenCalledTimes(2);
  const signal = t.getManagedCredit.mock.calls[0]![0] as AbortSignal;
  view.unmount(); await act(async () => {}); expect(signal.aborted).toBe(true);
  pending.resolve(observation()); await act(async () => {}); expect(vi.getTimerCount()).toBe(0);
});
it("cancels a late old-identity read synchronously when runtime ownership changes", async () => {
  const t = setup(); const pending = deferred<ProviderManagedCreditObservation>(); t.getManagedCredit.mockReturnValue(pending.promise);
  const next = setup();
  const view = renderHook(({ identity, transport }) => useProviderSettingsController({ identityKey: identity, transport, automaticCreditRefreshEnabled: true }), { initialProps: { identity: "old", transport: t.transport } });
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  view.rerender({ identity: "new", transport: next.transport }); await act(async () => {});
  expect((t.getManagedCredit.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
  pending.resolve(observation(1_000_000)); await act(async () => {});
  expect(view.result.current.identityKey).toBe("new"); expect(view.result.current.snapshot?.accessSources[0]?.usage).toEqual(next.original.accessSources[0]!.usage);
});
it.each(["missing_chat", "budget_zero"])("%s gates funding without erasing independent route verification", async kind => {
  const t = setup(); await t.controller.refresh({ refresh: false }); const next = observation();
  if (kind === "missing_chat") delete next.usage.chatAvailability;
  else { next.usage.usedMicrousd = 5_000_000; next.usage.budget.settledThisMonthMicrousd = 5_000_000; next.usage.budget.remainingBudgetMicrousd = 0; next.usage.remainingMicrousd = 0; }
  t.getManagedCredit.mockResolvedValue(next); expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const source = t.controller.getState().snapshot!.accessSources[0]!;
  expect(source.readiness.state).toBe("ready");
  expect(gatewayChatAvailableMicrousd(source) ?? 0).toBe(0);
});

it("funding recovery cannot repair an independently observed authentication failure or add policy models", async () => {
  const t = setup();
  t.original.accessSources[0]!.readiness = { ...t.original.accessSources[0]!.readiness, state: "unavailable", safeReason: "auth", action: "enter_api_key" };
  await t.controller.refresh({ refresh: false });
  const before = t.controller.getState().snapshot!;
  vi.setSystemTime(Date.now() + 45_000);
  const next = observation(); next.policy.allowedModelIds.push("anthropic/unknown-model");
  t.getManagedCredit.mockResolvedValue(next);
  expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const accepted = t.controller.getState().snapshot!;
  expect(accepted.accessSources[0]!.readiness).toBe(before.accessSources[0]!.readiness);
  expect(accepted.accessSources[0]!.eligibleModelIds).toBe(before.accessSources[0]!.eligibleModelIds);
  expect(accepted.modelProviders).toBe(before.modelProviders);
  expect(accepted.gatewayPolicy!.allowedModelIds).toBe(before.gatewayPolicy!.allowedModelIds);
});
