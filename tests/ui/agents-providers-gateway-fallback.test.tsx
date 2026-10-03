// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";

const sonnet = "claude-sonnet-5";
const glm = "@cf/zai-org/glm-5.3-flash";
const now = "2026-10-02T07:28:30.187Z";

function partialSnapshot(): ProviderSettingsSnapshot {
  const harness: ProviderHarnessInstance = {
    id: "harness_hermes", harness: "hermes", displayName: "Hermes", accentColor: "teal",
    enabled: false, version: "1", installState: "installed", authState: "authenticated",
    loginMethods: [], recommendedLoginMethod: null, connectivity: "online", accountIds: [],
    selectedAccountId: null, accessSourceId: "matrix_included", activeChatCount: 0,
    route: { kind: "configurable", providerId: "anthropic", modelId: sonnet },
  };
  const source: ProviderSettingsSnapshot["accessSources"][number] = {
    id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included",
    providerId: "anthropic", accountId: null, displayName: "Matrix AI",
    readiness: { state: "ready", checkedAt: now, staleAfter: "2026-10-02T07:28:57.304Z", action: "none", safeReason: null },
    eligibleModelIds: [sonnet],
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable",
      scope: "access_source", reason: "provider_does_not_report", asOf: now },
  };
  return {
    contractVersion: 1, revision: 0, refreshedAt: now,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 0 },
    access: { mode: "writable" }, atomicConnectSupported: true,
    supportedActions: ["set_route"], configurationHarnessKinds: ["hermes", "openclaw", "pi", "opencode"],
    harnessCatalog: (["hermes", "openclaw", "pi", "opencode"] as const).map((kind) => ({
      harness: kind, displayName: kind, installState: "installed", available: true,
      runnable: true, setupAction: "none", safeReason: null,
    })),
    modelProviders: [
      { id: "anthropic", displayName: "Anthropic", models: [{ id: sonnet, displayName: "Claude Sonnet 5", enabled: true }] },
      { id: "cloudflare", displayName: "Cloudflare", models: [{ id: glm, displayName: "GLM", enabled: true }] },
    ],
    accessSources: [
      { ...source, id: "matrix_cloudflare", providerId: "cloudflare", eligibleModelIds: [],
        readiness: { state: "unavailable", checkedAt: now, staleAfter: null, action: "retry", safeReason: "provider_unavailable" } },
      source,
    ],
    accounts: [], harnesses: [harness, {
      ...harness, id: "harness_pi", harness: "pi", displayName: "Pi", enabled: false,
      accessSourceId: null, route: { kind: "configurable", providerId: "anthropic", modelId: sonnet },
    }],
    gatewayPolicy: { accessSourceId: "matrix_cloudflare", allowedModelIds: [sonnet], monthlyBudgetMicrousd: 5_100_000, topUpEnabled: false },
  };
}

function setup(snapshot: ProviderSettingsSnapshot, initialHarnessId = "harness_hermes") {
  const onRefresh = vi.fn();
  const onMutate = vi.fn();
  function ControlledView() {
    const [selectedHarnessId, onSelectHarness] = useState(initialHarnessId);
    return <AgentsProvidersView snapshot={snapshot} selectedHarnessId={selectedHarnessId}
      onSelectHarness={onSelectHarness} onRefresh={onRefresh} onMutate={onMutate}
      onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()}
      onSetupHarness={vi.fn().mockResolvedValue(true)} />;
  }
  render(<ControlledView />);
  return { onRefresh, onMutate };
}

function heldSnapshot(): ProviderSettingsSnapshot {
  const next = partialSnapshot();
  const source = next.accessSources[1]!;
  source.readiness = { state: "unavailable", checkedAt: now, staleAfter: null, action: "retry", safeReason: "credit_reserved" };
  source.usage = { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
    usedMicrousd: 297_893, remainingMicrousd: 0, limitMicrousd: 5_100_000,
    periodStartedAt: "2026-10-01T00:00:00.000Z", resetsAt: null, asOf: now,
    credit: { promotionalBalanceMicrousd: 4_802_107, addonBalanceMicrousd: 0, creditBalanceMicrousd: 4_802_107,
      reservedMicrousd: 4_802_107, remainingBalanceMicrousd: 0 },
    budget: { monthlyBudgetMicrousd: 5_100_000, settledThisMonthMicrousd: 297_893,
      reservedThisMonthMicrousd: 4_802_107, remainingBudgetMicrousd: 0 } };
  return next;
}

describe("Matrix source fallback for native Pi setup", () => {
  it("prefers fully ready allowed Cloudflare when choosing an unbound Pi", () => {
    const next = partialSnapshot();
    next.accessSources[0]!.readiness = { ...next.accessSources[1]!.readiness };
    next.accessSources[0]!.eligibleModelIds = [glm];
    next.gatewayPolicy!.allowedModelIds.push(glm);
    const originalPi = structuredClone(next.harnesses[1]);
    const { onRefresh, onMutate } = setup(next);
    expect(screen.getByLabelText("Model")).toHaveValue(sonnet);
    fireEvent.click(within(screen.getByRole("region", { name: "Matrix AI" })).getByRole("button", { name: "Choose Pi" }));
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Ready")).toBeVisible();
    expect(within(gateway).getByText("Pi · GLM")).toBeVisible();
    expect(screen.getByLabelText("Model")).toHaveValue(sonnet);
    expect(next.harnesses[1]).toEqual(originalPi);
    expect(onMutate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("preserves an explicitly saved unavailable Pi source instead of switching credentials", () => {
    const next = partialSnapshot();
    const pi = next.harnesses[1]!;
    pi.accessSourceId = "matrix_cloudflare";
    pi.route = { kind: "configurable", providerId: "cloudflare", modelId: glm };
    const originalPi = structuredClone(pi);
    const { onRefresh, onMutate } = setup(next);
    fireEvent.click(within(screen.getByRole("region", { name: "Matrix AI" })).getByRole("button", { name: "Choose Pi" }));
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Unavailable")).toBeVisible();
    expect(within(gateway).queryByText("Ready")).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Pi connection" })).getByRole("button", { name: /Use Matrix AI/ })).toBeDisabled();
    expect(pi).toEqual(originalPi);
    expect(onMutate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "empty", "denied", "disabled"] as const)(
    "keeps the allowed Anthropic route Ready after Choose Pi when Cloudflare is %s",
    (failure) => {
      const next = partialSnapshot();
      const cloudflare = next.accessSources[0]!;
      if (failure !== "unavailable") cloudflare.readiness = { ...next.accessSources[1]!.readiness };
      if (failure === "denied" || failure === "disabled") cloudflare.eligibleModelIds = [glm];
      if (failure === "disabled") {
        next.gatewayPolicy!.allowedModelIds.push(glm);
        next.modelProviders[1]!.models[0]!.enabled = false;
      }
      const originalPi = structuredClone(next.harnesses[1]);
      const { onRefresh, onMutate } = setup(next);
      let gateway = screen.getByRole("region", { name: "Matrix AI" });
      expect(within(gateway).getByText("Ready")).toBeVisible();
      fireEvent.click(within(gateway).getByRole("button", { name: "Choose Pi" }));
      gateway = screen.getByRole("region", { name: "Matrix AI" });
      expect(within(gateway).getByText("Ready")).toBeVisible();
      const connection = screen.getByRole("group", { name: "Pi connection" });
      expect(within(connection).getByRole("button", { name: /Use Matrix AI/ })).toBeEnabled();
      expect(within(connection).getByRole("button", { name: /Own account/ })).toBeEnabled();
      expect(screen.getByLabelText("Model")).toHaveValue(sonnet);
      expect(next.harnesses[1]).toEqual(originalPi);
      expect(onMutate).not.toHaveBeenCalled();
      expect(onRefresh).not.toHaveBeenCalled();
      expect(screen.getAllByRole("region", { name: "Matrix AI" })).toHaveLength(1);
    },
  );

  it.each(["empty", "denied", "disabled"] as const)(
    "does not invent readiness when every source has an %s model intersection",
    (failure) => {
      const next = partialSnapshot();
      next.harnesses[0]!.accessSourceId = null;
      next.accessSources[0]!.readiness = { ...next.accessSources[1]!.readiness };
      next.accessSources[0]!.eligibleModelIds = [glm];
      if (failure === "empty") next.accessSources[1]!.eligibleModelIds = [];
      if (failure === "denied") next.gatewayPolicy!.allowedModelIds = [];
      if (failure === "disabled") next.modelProviders[0]!.models[0]!.enabled = false;
      setup(next);
      const gateway = screen.getByRole("region", { name: "Matrix AI" });
      expect(within(gateway).queryByText("Ready")).not.toBeInTheDocument();
      expect(within(gateway).getByText("Unavailable")).toBeVisible();
      expect(within(gateway).getByRole("button", { name: "Check again" })).toBeEnabled();
      expect(within(gateway).queryByRole("button", { name: "Choose Pi" })).not.toBeInTheDocument();
    },
  );
  it.each(["credit_reserved", "credit_required"] as const)("shows authorized Sonnet discovery for an unbound Pi with %s before the empty policy anchor", (reason) => {
    const next = heldSnapshot();
    const source = next.accessSources[1]!;
    source.readiness.safeReason = reason;
    if (reason === "credit_required" && source.usage.kind === "managed_credit") {
      source.usage.credit = { promotionalBalanceMicrousd: 0, addonBalanceMicrousd: 0, creditBalanceMicrousd: 0, reservedMicrousd: 0, remainingBalanceMicrousd: 0 };
      source.usage.usedMicrousd = source.usage.limitMicrousd;
      source.usage.budget.settledThisMonthMicrousd = source.usage.limitMicrousd;
      source.usage.budget.reservedThisMonthMicrousd = 0;
    }
    const originalPi = structuredClone(next.harnesses[1]);
    const { onMutate, onRefresh } = setup(next, "harness_pi");
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText(reason === "credit_reserved" ? "Credit reserved" : "Credit needed")).toBeVisible();
    fireEvent.click(within(gateway).getByText("Usage & available models"));
    expect(within(gateway).getByText("Claude Sonnet 5")).toBeVisible();
    expect(within(gateway).queryByText("Ready")).not.toBeInTheDocument();
    expect(within(gateway).queryByRole("button", { name: /Choose|Use Matrix AI/ })).not.toBeInTheDocument();
    expect(next.harnesses[1]).toEqual(originalPi);
    expect(onMutate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("preserves an explicit empty Cloudflare source even when Sonnet discovery has a current credit hold", () => {
    const next = heldSnapshot();
    next.harnesses[1]!.accessSourceId = "matrix_cloudflare";
    setup(next, "harness_pi");
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Unavailable")).toBeVisible();
    fireEvent.click(within(gateway).getByText("Usage & available models"));
    expect(within(gateway).queryByText("Claude Sonnet 5")).not.toBeInTheDocument();
    expect(within(gateway).queryByText("Credit reserved")).not.toBeInTheDocument();
  });

  it("prefers current funding discovery over a different authorized connection failure", () => {
    const next = heldSnapshot();
    next.accessSources[0]!.eligibleModelIds = [glm];
    next.accessSources[0]!.usage = structuredClone(next.accessSources[1]!.usage);
    next.gatewayPolicy!.allowedModelIds.push(glm);
    setup(next, "harness_pi");
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Credit reserved")).toBeVisible();
  });

  it.each(["empty", "denied", "disabled", "stale_usage", "stale_readiness", "unobserved"] as const)(
    "does not use %s discovery to replace an empty policy anchor", (failure) => {
      const next = heldSnapshot();
      const source = next.accessSources[1]!;
      if (failure === "empty") source.eligibleModelIds = [];
      if (failure === "denied") next.gatewayPolicy!.allowedModelIds = [];
      if (failure === "disabled") next.modelProviders[0]!.models[0]!.enabled = false;
      if (failure === "stale_usage" && source.usage.kind === "managed_credit") source.usage.state = "stale";
      if (failure === "stale_readiness") source.readiness.state = "stale";
      if (failure === "unobserved") source.readiness.checkedAt = null;
      setup(next, "harness_pi");
      const gateway = screen.getByRole("region", { name: "Matrix AI" });
      expect(within(gateway).getByText("Unavailable")).toBeVisible();
      expect(within(gateway).queryByText("Credit reserved")).not.toBeInTheDocument();
    },
  );

  it("still prefers a ready allowed Cloudflare route before a current Sonnet hold", () => {
    const next = heldSnapshot();
    next.accessSources[0]!.readiness = { ...partialSnapshot().accessSources[1]!.readiness };
    next.accessSources[0]!.eligibleModelIds = [glm];
    next.gatewayPolicy!.allowedModelIds.push(glm);
    setup(next, "harness_pi");
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Ready")).toBeVisible();
    expect(within(gateway).getByText("Pi · GLM")).toBeVisible();
  });

  it("shows fresh authorized discovery for a connection failure before an empty policy anchor", () => {
    const next = heldSnapshot();
    next.accessSources[1]!.readiness.safeReason = "provider_unavailable";
    setup(next, "harness_pi");
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    expect(within(gateway).getByText("Unavailable")).toBeVisible();
    fireEvent.click(within(gateway).getByText("Usage & available models"));
    expect(within(gateway).getByText("Claude Sonnet 5")).toBeVisible();
    expect(within(gateway).queryByText("Credit reserved")).not.toBeInTheDocument();
    expect(within(gateway).queryByText("Ready")).not.toBeInTheDocument();
  });

});
