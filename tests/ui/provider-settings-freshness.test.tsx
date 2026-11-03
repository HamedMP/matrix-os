// @vitest-environment jsdom
import React, { useLayoutEffect } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { disconnectedSnapshot } from "./chat-provider-settings-fixture";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { gatewayChatAvailableMicrousd, gatewayCreditLines, gatewayCreditStaleAfter } from "../../packages/ui/src/agents-providers/utils";
import { useLocalObservationExpiry } from "../../packages/ui/src/local-observation-expiry";

const observedAt = "2026-10-14T08:00:00.000Z";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(observedAt); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function snapshotWithCredit() {
  const snapshot = disconnectedSnapshot();
  snapshot.accessSources = [{
    id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included",
    providerId: "anthropic", accountId: null, displayName: "Matrix AI", eligibleModelIds: ["sonnet"],
    readiness: { state: "ready", checkedAt: observedAt, staleAfter: null, action: "none", safeReason: null },
    usage: { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
      usedMicrousd: 20_000, remainingMicrousd: 4_980_000, limitMicrousd: 5_000_000,
      periodStartedAt: observedAt, resetsAt: null, asOf: observedAt,
      chatAvailability: { contractVersion: 1, asOf: observedAt, eligibleBalanceMicrousd: 4_980_000, availableBalanceMicrousd: 4_980_000 },
      credit: { promotionalBalanceMicrousd: 4_980_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 4_980_000,
        reservedMicrousd: 0, remainingBalanceMicrousd: 4_980_000 },
      budget: { monthlyBudgetMicrousd: 5_000_000, settledThisMonthMicrousd: 20_000, reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: 4_980_000 } },
  }];
  snapshot.gatewayPolicy = { accessSourceId: "matrix_included", allowedModelIds: ["sonnet"], monthlyBudgetMicrousd: 5_000_000, topUpEnabled: false };
  return snapshot;
}

function snapshotWithPiCredit(saved: boolean) {
  const snapshot = snapshotWithCredit();
  snapshot.supportedActions.push("set_route");
  snapshot.configurationHarnessKinds = ["pi"];
  snapshot.atomicConnectSupported = true;
  snapshot.harnesses = [{ ...snapshot.harnesses[0]!, id: "pi_default", harness: "pi", displayName: "Pi", enabled: true,
    accessSourceId: saved ? "matrix_included" : null,
    route: { kind: "configurable", providerId: "anthropic", modelId: "sonnet" } }];
  return snapshot;
}

function snapshotWithTwoGatewayRoutes() {
  const snapshot = snapshotWithPiCredit(false);
  snapshot.supportedActions.push("set_gateway_budget");
  const reserved = snapshot.accessSources[0]!;
  if (reserved.usage.kind !== "managed_credit" || !reserved.usage.chatAvailability) throw new Error("fixture must provide credit");
  const cloudflare = structuredClone(reserved);
  cloudflare.id = "matrix_cloudflare";
  cloudflare.providerId = "cloudflare";
  cloudflare.eligibleModelIds = ["@cf/zai-org/glm-5.3-flash"];
  snapshot.modelProviders.push({ id: "cloudflare", displayName: "Cloudflare", models: [{ id: "@cf/zai-org/glm-5.3-flash", displayName: "GLM", enabled: true }] });
  snapshot.gatewayPolicy!.allowedModelIds.push("@cf/zai-org/glm-5.3-flash");
  reserved.readiness = { ...reserved.readiness, state: "unavailable", action: "retry", safeReason: "credit_reserved" };
  reserved.usage.chatAvailability.availableBalanceMicrousd = 0;
  reserved.usage.credit.reservedMicrousd = 4_980_000;
  reserved.usage.budget.remainingBudgetMicrousd = 0;
  snapshot.accessSources = [cloudflare, reserved];
  return snapshot;
}

function show(snapshot = disconnectedSnapshot(), workflowClient?: ProviderWorkflowClient) {
  const onRefresh = vi.fn();
  const onMutate = vi.fn();
  const props = { onSelectHarness: vi.fn(), onRefresh, onMutate, onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), workflowClient };
  const content = (value: typeof snapshot) => <AgentsProvidersView {...props} snapshot={value} selectedHarnessId={value.harnesses[0]!.id} />;
  const view = render(content(snapshot));
  return { ...view, onRefresh, onMutate, replaceSnapshot: (value: typeof snapshot) => view.rerender(content(value)) };
}

it("advances Checked age on the same idle view without a snapshot read or mutation", async () => {
  const snapshot = disconnectedSnapshot();
  vi.setSystemTime(Date.parse(observedAt) + 3_000);
  const view = show(snapshot);
  expect(screen.getByText("Checked 3 seconds ago")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(347_000); });
  expect(screen.getByText("Checked 6 minutes ago")).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh provider status" })).toBeEnabled();
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(view.onMutate).not.toHaveBeenCalled();
});

it("expires the existing usage freshness boundary without needing an unrelated interaction", async () => {
  const view = show(snapshotWithCredit());
  expect(screen.getByText("$4.98")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(301_000); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(screen.queryByText("$4.98")).not.toBeInTheDocument();
  expect(screen.getByText(/Credit last confirmed/)).toBeVisible();
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(view.onMutate).not.toHaveBeenCalled();
});

it.each([false, true])("expires the parent-derived Matrix connection affordance (saved: %s) without a snapshot read", async (saved) => {
  const snapshot = snapshotWithPiCredit(saved);
  const view = show(snapshot);
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  const connection = screen.getByRole("group", { name: "Pi connection" });
  const choice = within(connection).getByRole("button", { name: saved ? /Using Matrix AI/ : /Use Matrix AI/ });
  expect(choice).toBeEnabled();
  expect(choice).toHaveAttribute("aria-pressed", String(saved));
  await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(choice).toBeDisabled();
  expect(choice).toHaveAttribute("aria-pressed", "false");
  expect(within(connection).getByText("Not available for this connection")).toBeVisible();
  fireEvent.click(choice);
  expect(view.onMutate).not.toHaveBeenCalled();
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(snapshot.harnesses[0]!.accessSourceId).toBe(saved ? "matrix_included" : null);
});

it("already applies the five-minute gate when an unrelated disclosure rerenders the old view", async () => {
  show(snapshotWithCredit());
  expect(screen.getByText("$4.98")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(301_000); });
  fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(screen.getByText("Checked 5 minutes ago")).toBeVisible();
});

it("preserves the existing inclusive five-minute boundary and expires immediately afterward", async () => {
  show(snapshotWithCredit());
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(screen.getByText("$4.98")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
});

it("catches up from wall-clock time after a delayed display tick", async () => {
  show();
  vi.setSystemTime(Date.parse(observedAt) + 347_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.getByText("Checked 6 minutes ago")).toBeVisible();
});

it("cleans up the age, credit and connection presentation timers on unmount", () => {
  const view = show(snapshotWithCredit());
  expect(vi.getTimerCount()).toBe(3);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces the displayed check age and credit deadline without applying the old expiry", async () => {
  const view = show(snapshotWithCredit());
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
  const next = snapshotWithCredit();
  next.refreshedAt = new Date().toISOString();
  const usage = next.accessSources[0]!.usage;
  if (usage.kind !== "managed_credit" || !usage.chatAvailability) throw new Error("fixture must provide credit");
  usage.asOf = next.refreshedAt;
  usage.chatAvailability.asOf = next.refreshedAt;
  await act(async () => { view.replaceSnapshot(next); });
  expect(screen.getByText("Checked now")).toBeVisible();
  expect(vi.getTimerCount()).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
  expect(screen.getByText("$4.98")).toBeVisible();
  expect(vi.getTimerCount()).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(vi.getTimerCount()).toBe(1);
  expect(view.onRefresh).not.toHaveBeenCalled();
});

it("keeps expanded rows, capabilities and actions stable across idle expiry and one explicit Refresh", async () => {
  const client: ProviderWorkflowClient = { capabilities: vi.fn().mockResolvedValue([]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() };
  const view = show(snapshotWithCredit(), client);
  await act(async () => {});
  const row = screen.getByRole("button", { name: /^Claude Code/ });
  fireEvent.click(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(347_000); });
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(client.capabilities).toHaveBeenCalledOnce();
  for (const action of [client.start, client.get, client.cancel, client.submitKey, client.logs]) expect(action).not.toHaveBeenCalled();
  expect(view.container.querySelector(".matrix-agents-providers")).not.toHaveAttribute("aria-busy", "true");
  const refresh = screen.getByRole("button", { name: "Refresh provider status" });
  expect(refresh).toBeEnabled();
  expect(view.onRefresh).not.toHaveBeenCalled();
  fireEvent.click(refresh);
  expect(view.onRefresh).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(view.onRefresh).toHaveBeenCalledOnce();
  expect(client.capabilities).toHaveBeenCalledOnce();
  expect(view.onMutate).not.toHaveBeenCalled();
  expect(row).toHaveAttribute("aria-expanded", "true");
});

it.each(["future", "invalid", "mismatched"])("retains conservative credit derivation for %s observations", (condition) => {
  const source = snapshotWithCredit().accessSources[0]!;
  if (source.usage.kind !== "managed_credit" || !source.usage.chatAvailability) throw new Error("fixture must provide credit");
  if (condition === "future") {
    source.usage.asOf = new Date(Date.now() + 60_001).toISOString();
    source.usage.chatAvailability.asOf = source.usage.asOf;
  }
  if (condition === "invalid") source.usage.asOf = "not-a-date";
  if (condition === "mismatched") source.usage.chatAvailability.asOf = new Date(Date.now() - 60_000).toISOString();
  expect(gatewayChatAvailableMicrousd(source)).toBeNull();
  expect(gatewayCreditLines(source).primary).toBe("Chat credit unavailable");
  if (condition === "invalid") expect(gatewayCreditStaleAfter(source)).toBeNull();
});

it("synchronizes replacement clock once even when successive wall-clock reads advance", async () => {
  let reads = 0;
  const start = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => start + reads++);
  let renders = 0;
  const view = renderHook(({ deadline }) => {
    renders++;
    return useLocalObservationExpiry([deadline]);
  }, { initialProps: { deadline: new Date(start + 10_000).toISOString() } });
  await act(async () => {});
  const initialClock = view.result.current;
  const initialRenders = renders;
  await act(async () => { view.rerender({ deadline: new Date(start + 20_000).toISOString() }); });
  expect(view.result.current).toBeGreaterThan(initialClock);
  expect(renders).toBe(initialRenders + 2);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("never promotes expired replacement credit using the retained clock before synchronization", async () => {
  const view = show(snapshotWithPiCredit(false));
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  const connection = screen.getByRole("group", { name: "Pi connection" });
  const choice = within(connection).getByRole("button", { name: /Use Matrix AI/ });
  expect(choice).toBeEnabled();
  vi.setSystemTime(Date.parse(observedAt) + 600_000);
  const next = snapshotWithPiCredit(false);
  const usage = next.accessSources[0]!.usage;
  if (usage.kind !== "managed_credit" || !usage.chatAvailability) throw new Error("fixture must provide credit");
  usage.asOf = new Date(Date.parse(observedAt) - 60_000).toISOString();
  usage.chatAvailability.asOf = usage.asOf;
  view.replaceSnapshot(next);
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(choice).toBeDisabled();
  await act(async () => {});
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(choice).toBeDisabled();
  expect(screen.queryByText("$4.98")).not.toBeInTheDocument();
  expect(view.onRefresh).not.toHaveBeenCalled();
});

it("uses wall-clock time when a delayed credit deadline wakes after a clock jump", async () => {
  const view = show(snapshotWithCredit());
  vi.setSystemTime(Date.parse(observedAt) + 3_600_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(screen.queryByText("$4.98")).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(1);
  expect(view.onRefresh).not.toHaveBeenCalled();
});

it("rearms a credit deadline after a backward wall-clock jump without spinning", async () => {
  const view = show(snapshotWithCredit());
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
  vi.setSystemTime(observedAt);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
  expect(screen.getByText("$4.98")).toBeVisible();
  expect(vi.getTimerCount()).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(vi.getTimerCount()).toBe(1);
  expect(view.onRefresh).not.toHaveBeenCalled();
});

it("cancels the pending replacement synchronization on disposal", async () => {
  const start = Date.now();
  const view = renderHook(({ deadline }) => useLocalObservationExpiry([deadline]), {
    initialProps: { deadline: new Date(start + 10_000).toISOString() },
  });
  view.rerender({ deadline: new Date(start + 20_000).toISOString() });
  expect(view.result.current).toBeNull();
  view.unmount();
  await act(async () => {});
  expect(vi.getTimerCount()).toBe(0);
});

it.each([300_000, 300_001])("expires credit and connection eligibility when effect setup reaches deadline %d", async (effectTime) => {
  const snapshot = snapshotWithPiCredit(false);
  const onRefresh = vi.fn();
  const onMutate = vi.fn();
  vi.setSystemTime(Date.parse(observedAt) + 299_999);
  function CrossDeadline() {
    useLayoutEffect(() => { vi.setSystemTime(Date.parse(observedAt) + effectTime); }, []);
    return <AgentsProvidersView snapshot={snapshot} selectedHarnessId={snapshot.harnesses[0]!.id}
      onSelectHarness={vi.fn()} onRefresh={onRefresh} onMutate={onMutate}
      onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} />;
  }
  render(<CrossDeadline />);
  await act(async () => {});
  if (effectTime === 300_000) {
    expect(screen.getByText("$4.98")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  const connection = screen.getByRole("group", { name: "Pi connection" });
  const choice = within(connection).getByRole("button", { name: /Use Matrix AI/ });
  expect(choice).toBeDisabled();
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText("Chat credit unavailable")).toBeVisible();
  expect(choice).toBeDisabled();
  expect(onRefresh).not.toHaveBeenCalled();
  expect(onMutate).not.toHaveBeenCalled();
});

it.each([0, 1])("retains the preferred source and budget draft while replacement clock eligibility synchronizes (usage ahead of projection: %dms)", async (usageAheadMs) => {
  const view = show(snapshotWithTwoGatewayRoutes());
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  const connection = screen.getByRole("group", { name: "Pi connection" });
  const choice = within(connection).getByRole("button", { name: /Use Matrix AI/ });
  expect(choice).toBeEnabled();
  const gateway = screen.getByRole("region", { name: "Matrix AI" });
  expect(within(gateway).getByText("GLM")).toBeVisible();
  const summary = within(gateway).getByText("Advanced Matrix AI settings");
  fireEvent.click(summary);
  const advanced = summary.closest("details")!;
  expect(advanced).toHaveAttribute("open");
  const budget = screen.getByLabelText("Monthly budget in USD");
  fireEvent.change(budget, { target: { value: "2.5" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  const next = snapshotWithTwoGatewayRoutes();
  next.refreshedAt = new Date(Date.now() - usageAheadMs).toISOString();
  for (const source of next.accessSources) {
    if (source.usage.kind !== "managed_credit" || !source.usage.chatAvailability) throw new Error("fixture must provide credit");
    source.usage.asOf = new Date().toISOString();
    source.usage.chatAvailability.asOf = source.usage.asOf;
  }
  view.replaceSnapshot(next);
  expect(screen.getByRole("region", { name: "Matrix AI" })).toBe(gateway);
  expect(screen.getByLabelText("Monthly budget in USD")).toBe(budget);
  expect(budget).toHaveValue("2.5");
  expect(advanced).toHaveAttribute("open");
  expect(within(gateway).getByText("GLM")).toBeVisible();
  expect(choice).toBeDisabled();
  fireEvent.click(choice);
  expect(view.onMutate).not.toHaveBeenCalled();
  await act(async () => {});
  expect(screen.getByRole("region", { name: "Matrix AI" })).toBe(gateway);
  expect(screen.getByLabelText("Monthly budget in USD")).toBe(budget);
  expect(budget).toHaveValue("2.5");
  expect(advanced).toHaveAttribute("open");
  expect(choice).toBeEnabled();
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(view.onMutate).not.toHaveBeenCalled();
});

it("does not temporarily prefer an unchanged expired source when a reserved sibling observation updates", async () => {
  const snapshot = snapshotWithTwoGatewayRoutes();
  const stalePreferred = snapshot.accessSources[0]!;
  if (stalePreferred.usage.kind !== "managed_credit" || !stalePreferred.usage.chatAvailability) throw new Error("fixture must provide credit");
  stalePreferred.usage.asOf = new Date(Date.parse(observedAt) - 300_001).toISOString();
  stalePreferred.usage.chatAvailability.asOf = stalePreferred.usage.asOf;
  const view = show(snapshot);
  const gateway = screen.getByRole("region", { name: "Matrix AI" });
  expect(within(gateway).getByText("Credit reserved")).toBeVisible();
  expect(within(gateway).queryByText("GLM")).not.toBeInTheDocument();
  const summary = within(gateway).getByText("Advanced Matrix AI settings");
  fireEvent.click(summary);
  const advanced = summary.closest("details")!;
  const budget = screen.getByLabelText("Monthly budget in USD");
  fireEvent.change(budget, { target: { value: "2.5" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  const next = structuredClone(snapshot);
  next.refreshedAt = new Date().toISOString();
  const reserved = next.accessSources[1]!;
  if (reserved.usage.kind !== "managed_credit" || !reserved.usage.chatAvailability) throw new Error("fixture must provide credit");
  reserved.usage.asOf = next.refreshedAt;
  reserved.usage.chatAvailability.asOf = next.refreshedAt;
  view.replaceSnapshot(next);
  expect(screen.getByRole("region", { name: "Matrix AI" })).toBe(gateway);
  expect(screen.getByLabelText("Monthly budget in USD")).toBe(budget);
  expect(budget).toHaveValue("2.5");
  expect(advanced).toHaveAttribute("open");
  expect(within(gateway).getByText("Credit reserved")).toBeVisible();
  expect(within(gateway).queryByText("GLM")).not.toBeInTheDocument();
  await act(async () => {});
  expect(screen.getByRole("region", { name: "Matrix AI" })).toBe(gateway);
  expect(screen.getByLabelText("Monthly budget in USD")).toBe(budget);
  expect(budget).toHaveValue("2.5");
  expect(advanced).toHaveAttribute("open");
  expect(within(gateway).getByText("Credit reserved")).toBeVisible();
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(view.onMutate).not.toHaveBeenCalled();
});

it.each(["removed", "saved_binding"] as const)("does not retain the previous unbound panel when its source is %s", async (change) => {
  const snapshot = snapshotWithTwoGatewayRoutes();
  const view = show(snapshot);
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  const oldGateway = screen.getByRole("region", { name: "Matrix AI" });
  expect(within(oldGateway).getByText("GLM")).toBeVisible();
  fireEvent.click(within(oldGateway).getByText("Advanced Matrix AI settings"));
  fireEvent.change(screen.getByLabelText("Monthly budget in USD"), { target: { value: "2.5" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  const next = structuredClone(snapshot);
  next.refreshedAt = new Date().toISOString();
  for (const source of next.accessSources) {
    if (source.usage.kind !== "managed_credit" || !source.usage.chatAvailability) throw new Error("fixture must provide credit");
    source.usage.asOf = next.refreshedAt;
    source.usage.chatAvailability.asOf = next.refreshedAt;
  }
  if (change === "removed") next.accessSources.splice(0, 1);
  else next.harnesses[0]!.accessSourceId = "matrix_included";
  view.replaceSnapshot(next);
  const gateway = screen.getByRole("region", { name: "Matrix AI" });
  expect(gateway).not.toBe(oldGateway);
  expect(within(gateway).getByText("Credit reserved")).toBeVisible();
  expect(within(gateway).queryByText("GLM")).not.toBeInTheDocument();
  const connection = screen.getByRole("group", { name: "Pi connection" });
  expect(within(connection).getByRole("button", { name: /Use Matrix AI/ })).toBeDisabled();
  await act(async () => {});
  expect(screen.getByRole("region", { name: "Matrix AI" })).toBe(gateway);
  expect(within(gateway).getByText("Credit reserved")).toBeVisible();
  expect(within(connection).getByRole("button", { name: /Use Matrix AI/ })).toBeDisabled();
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(view.onMutate).not.toHaveBeenCalled();
});
