// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { useProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { observation, snapshot, start } from "./provider-managed-credit-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each(["zero", "missing_chat", "budget_zero"])("recovers %s funding in the mounted view without losing verified route evidence", async barrier => {
  const original = snapshot();
  const getSnapshot = vi.fn().mockResolvedValue(original);
  const getManagedCredit = vi.fn(async () => {
    const next = observation(barrier === "zero" ? 0 : 3_000_000);
    if (barrier === "missing_chat") delete next.usage.chatAvailability;
    if (barrier === "budget_zero") {
      next.usage.usedMicrousd = next.usage.budget.settledThisMonthMicrousd = 5_000_000;
      next.usage.remainingMicrousd = next.usage.budget.remainingBudgetMicrousd = 0;
    }
    return next;
  });
  const transport = { getSnapshot, getManagedCredit, mutate: vi.fn() };
  function Settings() {
    const state = useProviderSettingsController({ identityKey: "recovery", transport, automaticCreditRefreshEnabled: true });
    return state.snapshot ? <AgentsProvidersView snapshot={state.snapshot} selectedHarnessId={state.selectedHarnessId} busy={state.busy} onSelectHarness={state.onSelectHarness} onRefresh={() => void state.refresh()} onMutate={state.mutate} /> : null;
  }
  render(<Settings />); await act(async () => {});
  expect(screen.getByText("Ready")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(screen.queryByText("Ready")).toBeNull();
  getManagedCredit.mockImplementation(async () => observation(3_000_000));
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(screen.getByText("$3.00")).toBeVisible();
  expect(screen.getByText("Ready")).toBeVisible();
  expect(screen.queryByText("Credit needed")).toBeNull();
  expect(getSnapshot).toHaveBeenCalledTimes(1);
});
