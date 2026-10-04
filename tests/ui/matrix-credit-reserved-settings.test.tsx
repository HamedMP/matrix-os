// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProviderAccessSource } from "@matrix-os/contracts";
import { GatewayPanel } from "../../packages/ui/src/agents-providers/GatewayPanel";

afterEach(cleanup);
function heldSource(): ProviderAccessSource {
  return {
    id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null,
    displayName: "Matrix AI", eligibleModelIds: ["claude-sonnet-5"],
    readiness: { state: "unavailable", safeReason: "credit_reserved", action: "retry", checkedAt: "2026-10-02T08:48:00.000Z", staleAfter: null },
    usage: { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
      usedMicrousd: 297_893, remainingMicrousd: 0, limitMicrousd: 5_100_000,
      periodStartedAt: "2026-10-01T00:00:00.000Z", resetsAt: null, asOf: "2026-10-02T08:48:00.000Z",
      credit: { promotionalBalanceMicrousd: 4_802_107, addonBalanceMicrousd: 0, creditBalanceMicrousd: 4_802_107,
        reservedMicrousd: 4_802_107, remainingBalanceMicrousd: 0 },
      budget: { monthlyBudgetMicrousd: 5_100_000, settledThisMonthMicrousd: 297_893, reservedThisMonthMicrousd: 4_802_107, remainingBudgetMicrousd: 0 } },
  };
}
function show(source: ProviderAccessSource) {
  const onAddCredit = vi.fn(); const onRefresh = vi.fn(); const onUseGateway = vi.fn();
  render(<GatewayPanel source={source} policy={{ accessSourceId: source.id, allowedModelIds: ["claude-sonnet-5"], monthlyBudgetMicrousd: 5_100_000, topUpEnabled: false }}
    provider={{ id: "anthropic", displayName: "Anthropic", models: [{ id: "claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true }] }}
    disabled={false} canSetBudget={false} canSetAllowlist={false} canAddCredit={false}
    onRefresh={onRefresh} onMutate={vi.fn()} onAddCredit={onAddCredit} onUseGateway={onUseGateway} />);
  return {onAddCredit, onRefresh, onUseGateway};
}
it("separates spendable credit, reserved credit and settled usage without offering execution", () => {
  const actions = show(heldSource());
  expect(screen.getByText("Credit reserved")).toBeVisible();
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeVisible();
  expect(screen.getByText("$0.00")).toBeVisible();
  expect(screen.getByText("$4.80 reserved")).toBeVisible();
  fireEvent.click(screen.getByText("Advanced Matrix AI settings"));
  expect(screen.getByText("$0.30 used of $5.10")).toBeVisible();
  expect(screen.queryByText("Matrix AI connection not verified. Check again.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Use Matrix AI" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Buy credit" }));
  expect(screen.getByText("Credit purchases are not enabled for this computer. Contact your workspace administrator or support.")).toBeVisible();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", {name: "Continue to checkout"})).toBeNull();
  expect(within(screen.getByRole("dialog")).queryByRole("button", {name: "Check again"})).toBeNull();
  expect(actions.onRefresh).not.toHaveBeenCalled();
  expect(actions.onAddCredit).not.toHaveBeenCalled();
  expect(actions.onUseGateway).not.toHaveBeenCalled();
});
it("does not describe unrelated failures or stale ledger values as a current credit hold", () => {
  const source = heldSource();
  source.readiness.safeReason = "provider_unavailable";
  if (source.usage.kind === "managed_credit") source.usage.state = "stale";
  show(source);
  expect(screen.queryByText("Credit reserved")).toBeNull();
  expect(screen.queryByText("Your credit is reserved while usage is confirmed.")).toBeNull();
  expect(screen.queryByText("Matrix AI connection not verified. Check again.")).toBeNull();
  expect(screen.getByText("$4.80 reserved (last confirmed)")).toBeVisible();
});
it("identifies a monthly budget reservation separately when its amount differs from credit reserved", () => {
  const source = heldSource();
  if (source.usage.kind !== "managed_credit") throw new Error("Managed fixture required");
  source.usage.credit.reservedMicrousd = 0;
  source.usage.credit.remainingBalanceMicrousd = source.usage.credit.creditBalanceMicrousd;
  show(source);
  fireEvent.click(screen.getByText("Advanced Matrix AI settings"));
  expect(screen.getByText("$4.80 monthly budget reserved")).toBeVisible();
  expect(screen.queryByText("$4.80 reserved")).toBeNull();
  expect(screen.getByText("$4.80")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Use Matrix AI" })).toBeNull();
});
it("does not direct a credit-needed owner to an unavailable purchase action", () => {
  const source = heldSource();
  source.readiness.safeReason = "credit_required";
  if (source.usage.kind !== "managed_credit") throw new Error("Managed fixture required");
  source.usage.credit = { promotionalBalanceMicrousd: 0, addonBalanceMicrousd: 0, creditBalanceMicrousd: 0, reservedMicrousd: 0, remainingBalanceMicrousd: 0 };
  source.usage.usedMicrousd = source.usage.limitMicrousd;
  source.usage.budget.settledThisMonthMicrousd = source.usage.limitMicrousd;
  source.usage.budget.reservedThisMonthMicrousd = 0;
  const actions = show(source);
  expect(screen.getByText("Matrix AI needs spendable credit.")).toBeVisible();
  expect(screen.queryByText("Add credit to use Matrix AI.")).toBeNull();
  expect(screen.queryByText("Matrix AI credit purchases are not available yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Buy credit"}));
  expect(screen.getByText("Credit purchases are not enabled for this computer. Contact your workspace administrator or support.")).toBeVisible();
  expect(screen.queryByRole("button", {name: "Continue to checkout"})).toBeNull();
  expect(actions.onAddCredit).not.toHaveBeenCalled();
  expect(actions.onUseGateway).not.toHaveBeenCalled();
});
