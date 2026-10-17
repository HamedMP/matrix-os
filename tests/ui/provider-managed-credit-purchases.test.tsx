// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { ProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("revokes purchase capability coherently when an authoritative top-up observation is disabled", async () => {
  const original = snapshot(); original.gatewayPolicy!.topUpEnabled = true; original.supportedActions.push("add_credit");
  expect(ProviderSettingsSnapshotSchema.safeParse(original).success).toBe(true);
  const onCatalogChanged = vi.fn(); const onAddCredit = vi.fn();
  const controller = new ProviderSettingsController({ identityKey: "purchases", onCatalogChanged, transport: {
    getSnapshot: vi.fn().mockResolvedValue(original), getManagedCredit: vi.fn(async () => observation()), mutate: vi.fn(),
  } });
  await controller.refresh({ refresh: false });
  const before = controller.getState().snapshot!;
  const props = { selectedHarnessId: null, busy: false, onSelectHarness: vi.fn(), onRefresh: vi.fn(), onMutate: vi.fn(), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit };
  const view = render(<AgentsProvidersView snapshot={controller.getState().snapshot!} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Buy credit" }));
  expect(screen.getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
  vi.setSystemTime(Date.now() + 45_000);
  expect(await controller.refreshManagedCredit()).toBe("updated");
  const accepted = controller.getState().snapshot!;
  expect.soft(accepted.gatewayPolicy!.topUpEnabled).toBe(false);
  expect.soft(accepted.supportedActions).not.toContain("add_credit");
  expect.soft(ProviderSettingsSnapshotSchema.safeParse(accepted).success).toBe(true);
  expect(accepted.harnesses).toBe(before.harnesses);
  expect(accepted.modelProviders).toBe(before.modelProviders);
  expect(accepted.gatewayPolicy!.allowedModelIds).toBe(before.gatewayPolicy!.allowedModelIds);
  view.rerender(<AgentsProvidersView snapshot={accepted} {...props} />);
  expect(screen.queryByRole("button", { name: "Continue to checkout" })).toBeNull();
  expect(screen.getByText("Credit purchases are not enabled for this computer. Contact your workspace administrator or support.")).toBeVisible();
  expect(onAddCredit).not.toHaveBeenCalled(); expect(onCatalogChanged).not.toHaveBeenCalled();
  controller.dispose();
});

it.each([false, null])("cannot add a purchase workflow from summary alone when initial policy is %s", async initial => {
  const original = snapshot(); if (initial === null) original.gatewayPolicy = null;
  expect(ProviderSettingsSnapshotSchema.safeParse(original).success).toBe(true);
  const controller = new ProviderSettingsController({ identityKey: "no-purchase-workflow", transport: {
    getSnapshot: vi.fn().mockResolvedValue(original), getManagedCredit: vi.fn(async () => {
      const next = observation(); next.topUpEnabled = true;
      if (initial === null) next.gatewayPolicyAccessSourceId = null;
      return next;
    }), mutate: vi.fn(),
  } });
  await controller.refresh({ refresh: false }); vi.setSystemTime(Date.now() + 45_000);
  expect(await controller.refreshManagedCredit()).toBe("updated");
  const accepted = controller.getState().snapshot!;
  expect(accepted.supportedActions).not.toContain("add_credit");
  expect(ProviderSettingsSnapshotSchema.safeParse(accepted).success).toBe(true);
  controller.dispose();
});
