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

function setup(snapshot: ProviderSettingsSnapshot) {
  const onRefresh = vi.fn();
  const onMutate = vi.fn();
  function ControlledView() {
    const [selectedHarnessId, onSelectHarness] = useState("harness_hermes");
    return <AgentsProvidersView snapshot={snapshot} selectedHarnessId={selectedHarnessId}
      onSelectHarness={onSelectHarness} onRefresh={onRefresh} onMutate={onMutate}
      onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()}
      onSetupHarness={vi.fn().mockResolvedValue(true)} />;
  }
  render(<ControlledView />);
  return { onRefresh, onMutate };
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
});
