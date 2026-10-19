// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { ProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { isMatrixGatewaySourceReady, matrixGatewayEligibleModels } from "../../packages/ui/src/agents-providers/GatewayPanel";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(boundModel = "opus") {
  const original = snapshot();
  original.modelProviders[0]!.models.push({ id: "opus", displayName: "Opus", enabled: true });
  original.accessSources[0]!.eligibleModelIds.push("opus");
  original.gatewayPolicy!.allowedModelIds.push("opus");
  original.harnesses = [{ ...original.harnesses[0]!, id: "pi_default", harness: "pi", displayName: "Pi",
    accessSourceId: "matrix_included", enabled: true,
    route: { kind: "configurable", providerId: "anthropic", modelId: boundModel } }];
  original.configurationHarnessKinds = ["pi"];
  original.harnessCatalog = original.harnessCatalog.map(entry => entry.harness === "pi"
    ? { ...entry, available: true, runnable: true, installState: "installed", setupAction: "none", safeReason: null }
    : entry);
  original.atomicConnectSupported = true;
  original.supportedActions.push("set_route", "select_access_source");
  ProviderSettingsSnapshotSchema.parse(original);
  const getSnapshot = vi.fn().mockResolvedValue(original);
  const getManagedCredit = vi.fn().mockResolvedValue(observation());
  const controller = new ProviderSettingsController({ identityKey: "policy-owner/runtime",
    transport: { getSnapshot, getManagedCredit, mutate: vi.fn() } });
  return { original, controller, getSnapshot, getManagedCredit };
}

it.each(["sonnet", "anthropic/sonnet"])("keeps the allowed route ready after partial policy revocation (%s)", async allowed => {
  const t = setup(); await t.controller.refresh({ refresh: false });
  const before = t.controller.getState().snapshot!;
  const next = observation(); next.policy.allowedModelIds = [allowed];
  t.getManagedCredit.mockResolvedValue(next);
  expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const accepted = t.controller.getState().snapshot!;
  const source = accepted.accessSources[0]!;
  expect(source.readiness).toBe(before.accessSources[0]!.readiness);
  expect(matrixGatewayEligibleModels(source, accepted.gatewayPolicy, accepted.modelProviders[0]!))
    .toEqual([accepted.modelProviders[0]!.models[0]]);
  expect(isMatrixGatewaySourceReady(source, accepted.gatewayPolicy, accepted.modelProviders[0]!)).toBe(true);
  expect(accepted.harnesses[0]!.route.modelId).toBe("opus");
  expect(accepted.gatewayPolicy!.allowedModelIds).toBe(before.gatewayPolicy!.allowedModelIds);
  expect(source.eligibleModelIds).toBe(before.accessSources[0]!.eligibleModelIds);
  expect(ProviderSettingsSnapshotSchema.safeParse(accepted).success).toBe(true);
  expect(t.getSnapshot).toHaveBeenCalledTimes(1);
  t.controller.dispose();
});

it("does not re-add a revoked or new model on later quiet observations", async () => {
  const t = setup(); await t.controller.refresh({ refresh: false });
  const before = t.controller.getState().snapshot!;
  await t.controller.refreshManagedCredit();
  vi.setSystemTime(Date.now() + 45_000);
  const widened = observation(); widened.policy.allowedModelIds = ["anthropic/sonnet", "anthropic/opus", "anthropic/new-model"];
  t.getManagedCredit.mockResolvedValue(widened); await t.controller.refreshManagedCredit();
  const accepted = t.controller.getState().snapshot!;
  expect(accepted.accessSources[0]!.readiness.state).toBe("ready");
  expect(matrixGatewayEligibleModels(accepted.accessSources[0]!, accepted.gatewayPolicy, accepted.modelProviders[0]!))
    .toEqual([accepted.modelProviders[0]!.models[0]]);
  expect(accepted.modelProviders).toBe(before.modelProviders);
  t.controller.dispose();
});

it("keeps the remaining allowed Matrix choice enabled in the mounted Settings view", async () => {
  const t = setup("sonnet"); await t.controller.refresh({ refresh: false });
  await t.controller.refreshManagedCredit();
  const onMutate = vi.fn();
  render(<AgentsProvidersView snapshot={t.controller.getState().snapshot!} selectedHarnessId="pi_default"
    onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={onMutate}
    onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  const connection = screen.getByRole("group", { name: "Pi connection" });
  expect(within(connection).getByRole("button", { name: /Using Matrix AI|Use Matrix AI/ })).toBeEnabled();
  fireEvent.click(screen.getByText("Advanced configuration"));
  expect(within(screen.getByLabelText("Model")).queryByRole("option", { name: "Opus" })).toBeNull();
  expect(onMutate).not.toHaveBeenCalled();
  t.controller.dispose();
});

it("keeps complete revocation unavailable when a later funding observation widens policy", async () => {
  const t = setup(); await t.controller.refresh({ refresh: false });
  const disabled = observation(); disabled.policy.enabled = false; disabled.policy.allowedModelIds = [];
  t.getManagedCredit.mockResolvedValue(disabled);
  expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const revoked = t.controller.getState().snapshot!;
  expect(revoked.accessSources[0]!.readiness.state).toBe("unavailable");
  expect(ProviderSettingsSnapshotSchema.safeParse(revoked).success).toBe(true);
  vi.setSystemTime(Date.now() + 45_000);
  const enabled = observation(); enabled.policy.allowedModelIds.push("anthropic/opus");
  t.getManagedCredit.mockResolvedValue(enabled);
  expect(await t.controller.refreshManagedCredit()).toBe("updated");
  const accepted = t.controller.getState().snapshot!;
  expect(accepted.accessSources[0]!.readiness).toEqual(revoked.accessSources[0]!.readiness);
  expect(matrixGatewayEligibleModels(accepted.accessSources[0]!, accepted.gatewayPolicy, accepted.modelProviders[0]!)).toEqual([]);
  t.controller.dispose();
});

it.each([{ models: ["unknown"] }, { models: ["sonnet", "sonnet"] }])("rejects an invalid effective policy subset $models", ({ models }) => {
  const original = setup().original;
  const valid = { ...original, gatewayPolicy: { ...original.gatewayPolicy!, effectiveAllowedModelIds: ["sonnet"] } };
  expect(ProviderSettingsSnapshotSchema.safeParse(valid).success).toBe(true);
  expect(ProviderSettingsSnapshotSchema.safeParse({ ...valid,
    gatewayPolicy: { ...valid.gatewayPolicy, effectiveAllowedModelIds: models } }).success).toBe(false);
});
