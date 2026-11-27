// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProviderAccessSource, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AddHarnessDialog } from "../../packages/ui/src/agents-providers/AddHarnessDialog";
import { GatewayPanel, isMatrixGatewaySourceReady } from "../../packages/ui/src/agents-providers/GatewayPanel";
import { gatewayCreditLines, localDateTimeWithZone } from "../../packages/ui/src/agents-providers/utils";

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
  expect(screen.getByText("Chat credit", { exact: true })).toBeVisible();
  expect(screen.queryByText("Chat credit available")).toBeNull();
  expect(screen.getByText("$0.00")).toBeVisible();
  expect(screen.queryByText("$1.00")).toBeNull();
  expect(screen.queryByText(/voice credit/i)).toBeNull();
});
it("separates Preview Chat and dictation allowances from dollar credit", () => {
  freeze(); const s = source(); if (s.usage.kind !== "managed_credit") throw new Error("fixture");
  s.usage.previewQuota = { mode: "preview", requestLimit: 25, requestsUsed: 2, requestsRemaining: 23, maxConcurrency: 1,
    expiresAt: "2026-10-20T16:45:00.000Z" };
  render(<GatewayPanel source={s} policy={null} provider={null} disabled={false} canSetBudget={false} canSetAllowlist={false}
    canAddCredit={false} onMutate={vi.fn()} onAddCredit={vi.fn()} onRefresh={vi.fn()}
    speechPreviewQuota={{ mode: "preview", requestLimit: 25, requestsUsed: 1, requestsRemaining: 24, maxConcurrency: 1,
      expiresAt: "2026-10-20T16:45:00.000Z" }} />);
  const expiry = localDateTimeWithZone("2026-10-20T16:45:00.000Z");
  expect(expiry).toMatch(/\d{1,2}:\d{2}/);
  expect(expiry).toMatch(/(?:GMT|UTC|[A-Z]{2,})/);
  const allowances = screen.getByRole("group", { name: "Preview allowances" });
  expect(allowances).toHaveTextContent("Preview Chat");
  expect(allowances).toHaveTextContent("23 of 25 requests remaining");
  expect(allowances).toHaveTextContent("Preview dictation");
  expect(allowances).toHaveTextContent("24 of 25 requests remaining");
  expect(allowances).toHaveTextContent(`Available until ${expiry}`);
  expect(screen.getByText("Chat credit", { exact: true })).toBeVisible();
  expect(screen.getByText("$0.00")).toBeVisible();
});
it("shows and mutates the platform-projected upstream preference only when supplied", () => {
  freeze();
  const onMutate = vi.fn();
  const preference = { selectedUpstream: "cloudflare" as const, effectiveUpstream: "cloudflare" as const,
    revision: 2, updatedAt: now, validThrough: "2026-11-01T00:00:00.000Z" };
  const matrixSource = source();
  const policy = { accessSourceId: matrixSource.id, allowedModelIds: [], monthlyBudgetMicrousd: 1_000_000, topUpEnabled: true };
  const provider = { id: "anthropic", displayName: "Anthropic", models: [] };
  const view = render(<GatewayPanel source={matrixSource} policy={policy} provider={provider} disabled={false}
    canSetBudget={false} canSetAllowlist={false} canAddCredit={false} canSetUpstream
    upstreamPreference={preference} onMutate={onMutate} onAddCredit={vi.fn()} onRefresh={vi.fn()} />);
  const upstream = screen.getByRole("group", { name: "Matrix AI upstream" });
  expect(upstream).toHaveAccessibleDescription("Developer access");
  const cloudflare = within(upstream).getByRole<HTMLButtonElement>("button", { name: "Cloudflare", pressed: true });
  const bedrock = within(upstream).getByRole<HTMLButtonElement>("button", { name: "AWS Bedrock", pressed: false });
  expect(cloudflare).toBeVisible();
  for (const button of [cloudflare, bedrock]) {
    // An inline outline overrides the panel's keyboard focus ring.
    expect(button.style.outline).toBe("");
  }
  expect(screen.queryByText("Choose where Matrix AI sends requests for eligible models.")).toBeNull();
  fireEvent.click(bedrock);
  expect(onMutate).toHaveBeenCalledWith({ type: "set_gateway_upstream", expectedUpstreamRevision: 2,
    selectedUpstream: "aws_bedrock" });
  onMutate.mockClear();
  fireEvent.click(cloudflare);
  expect(onMutate).not.toHaveBeenCalled();
  view.unmount();
  render(<GatewayPanel source={matrixSource} policy={policy} provider={provider} disabled={false}
    canSetBudget={false} canSetAllowlist={false} canAddCredit={false}
    upstreamPreference={undefined} onMutate={onMutate} onAddCredit={vi.fn()} onRefresh={vi.fn()} />);
  expect(screen.queryByRole("group", { name: "Matrix AI upstream" })).toBeNull();
  expect(screen.queryByText("Advanced Matrix AI settings")).toBeNull();
  expect(screen.queryByText("Workspace controls")).toBeNull();
  expect(screen.getByText("Monthly budget")).toBeVisible();
  expect(screen.queryByText("Developer access")).toBeNull();
});
it.each(["Pi", "OpenCode"] as const)("excludes only the effective Bedrock model from the %s setup picker", label => {
  const matrixSource = source();
  matrixSource.eligibleModelIds = ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"];
  matrixSource.readiness = { ...matrixSource.readiness, state: "ready", safeReason: null, action: "none" };
  const snapshot: ProviderSettingsSnapshot = {
    contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
    revision: 1, refreshedAt: now, access: { mode: "writable" }, supportedActions: ["add_harness"],
    accessSources: [matrixSource], accounts: [], harnesses: [],
    harnessCatalog: ([["pi", "Pi"], ["opencode", "OpenCode"], ["hermes", "Hermes"], ["openclaw", "OpenClaw"]] as const)
      .map(([harness, displayName]) => ({ harness, displayName, installState: "installed", available: true,
        runnable: true, setupAction: "none", safeReason: null })),
    modelProviders: [{ id: "anthropic", displayName: "Anthropic", models: [
      { id: "anthropic/claude-opus-5", displayName: "Claude Opus 5", enabled: true },
      { id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true },
    ] }],
    gatewayPolicy: { accessSourceId: matrixSource.id, allowedModelIds: matrixSource.eligibleModelIds,
      monthlyBudgetMicrousd: 1_000_000, topUpEnabled: true },
    upstreamPreference: { selectedUpstream: "aws_bedrock", effectiveUpstream: "aws_bedrock",
      effectiveBedrockModelIds: ["anthropic/claude-opus-5"], revision: 2, updatedAt: now, validThrough: "2026-11-01T00:00:00.000Z" },
  };
  render(<AddHarnessDialog snapshot={snapshot} onMutate={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("option", { name: "Claude Sonnet 5" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "Claude Opus 5" })).toBeNull();
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
  else if (state === "future") { s.usage.asOf = "2026-10-05T09:01:00.001Z"; s.usage.chatAvailability!.asOf = s.usage.asOf; }
  else s.usage.chatAvailability!.asOf = "2026-10-05T08:59:59.000Z";
  expect(gatewayCreditLines(s).primary).toBe("Chat credit unavailable");
});
it.each([2_650, 60_000])("preserves zero Chat credit within the future tolerance (%dms) without substituting aggregate credit", skewMs => {
  freeze(); const s = source(); if (s.usage.kind !== "managed_credit") throw new Error("fixture");
  s.usage.asOf = new Date(Date.parse(now) + skewMs).toISOString();
  s.usage.chatAvailability!.asOf = s.usage.asOf;
  expect(gatewayCreditLines(s)).toEqual({ primary: "$0.00", secondary: null, stale: false });
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
