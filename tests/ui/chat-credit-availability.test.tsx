// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProviderAccessSource } from "@matrix-os/contracts";
import { GatewayPanel, isMatrixGatewaySourceReady } from "../../packages/ui/src/agents-providers/GatewayPanel";
import { gatewayCreditLines } from "../../packages/ui/src/agents-providers/utils";

const now = "2026-10-05T09:00:00.000Z";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function source(): ProviderAccessSource {
  return { id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic",
    accountId: null, displayName: "Matrix AI", eligibleModelIds: [],
    readiness: { state: "unavailable", safeReason: "credit_required", action: "retry", checkedAt: now, staleAfter: null },
    usage: { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
      usedMicrousd: 0, remainingMicrousd: 1_000_000, limitMicrousd: 1_000_000, periodStartedAt: now, resetsAt: null, asOf: now,
      credit: { promotionalBalanceMicrousd: 1_000_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 1_000_000,
        reservedMicrousd: 0, remainingBalanceMicrousd: 1_000_000 },
      budget: { monthlyBudgetMicrousd: 1_000_000, settledThisMonthMicrousd: 0, reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: 1_000_000 },
      chatAvailability: { contractVersion: 1, asOf: now, eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 } } };
}
function freeze() { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); }
it("shows zero ordinary Chat credit with a positive speech-inclusive total", () => {
  freeze(); const s = source();
  render(<GatewayPanel source={s} policy={null} provider={null} disabled={false} canSetBudget={false} canSetAllowlist={false}
    canAddCredit={false} onMutate={vi.fn()} onAddCredit={vi.fn()} onRefresh={vi.fn()} />);
  expect(screen.getByText("Chat credit available")).toBeVisible();
  expect(screen.getByText("$0.00")).toBeVisible();
  expect(screen.queryByText("$1.00")).toBeNull();
  expect(screen.queryByText(/voice credit/i)).toBeNull();
});
it.each([1, 4_999, 9_999, 10_000])("caps source credit by monthly budget and preserves precision: %s", amount => {
  freeze(); const s = source(); if (s.usage.kind !== "managed_credit") throw new Error("fixture");
  Object.assign(s.usage.chatAvailability!, { eligibleBalanceMicrousd: 1_000_000, availableBalanceMicrousd: 1_000_000 });
  s.usage.budget.remainingBudgetMicrousd = amount;
  expect(gatewayCreditLines(s).primary).toBe(amount < 10_000 ? `$${(amount / 1_000_000).toFixed(6)}` : "$0.01");
});
it.each(["missing", "stale", "future", "mismatch"])("never substitutes aggregate credit for %s observation", state => {
  freeze(); const s = source(); if (s.usage.kind !== "managed_credit") throw new Error("fixture");
  if (state === "missing") delete s.usage.chatAvailability;
  else if (state === "stale") { s.usage.asOf = "2026-10-05T08:54:59.999Z"; s.usage.chatAvailability!.asOf = s.usage.asOf; }
  else if (state === "future") { s.usage.asOf = "2026-10-05T09:00:00.001Z"; s.usage.chatAvailability!.asOf = s.usage.asOf; }
  else s.usage.chatAvailability!.asOf = "2026-10-05T08:59:59.000Z";
  expect(gatewayCreditLines(s).primary).toBe("Chat credit unavailable");
});
it.each(["missing", "stale", "zero", "budget_zero", "current"])("requires positive fresh Chat capacity before claiming Ready: %s", state => {
  freeze(); const s = source(); if (s.usage.kind !== "managed_credit") throw new Error("fixture");
  s.readiness = { ...s.readiness, state: "ready", action: "none", safeReason: null };
  s.eligibleModelIds = ["sonnet"];
  const policy = { accessSourceId: s.id, allowedModelIds: ["sonnet"], monthlyBudgetMicrousd: 1_000_000, topUpEnabled: true };
  const provider = { id: "anthropic", displayName: "Anthropic", models: [{ id: "sonnet", displayName: "Sonnet", enabled: true }] };
  if (state === "missing") delete s.usage.chatAvailability;
  else if (state !== "zero") Object.assign(s.usage.chatAvailability!, {eligibleBalanceMicrousd: 1_000_000, availableBalanceMicrousd: 1_000_000});
  if (state === "stale") s.usage.state = "stale";
  if (state === "budget_zero") s.usage.budget.remainingBudgetMicrousd = 0;
  expect(isMatrixGatewaySourceReady(s, policy, provider)).toBe(state === "current");
  render(<GatewayPanel source={s} policy={policy} provider={provider} disabled={false} canSetBudget={false} canSetAllowlist={false}
    canAddCredit={true} onMutate={vi.fn()} onAddCredit={vi.fn()} onRefresh={vi.fn()} onUseGateway={vi.fn()} />);
  expect(screen.queryByText("Ready") !== null).toBe(state === "current");
  expect(screen.queryByRole("button", {name: "Use Matrix AI"}) !== null).toBe(state === "current");
  if (state === "missing" || state === "stale") expect(screen.getByText("Chat credit unavailable")).toBeVisible();
});
