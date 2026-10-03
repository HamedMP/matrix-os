// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { GatewayPanel } from "../../packages/ui/src/agents-providers/GatewayPanel";

afterEach(cleanup);
const source = (id: string) => ({ id, kind: "matrix_gateway", readiness: { state: "ready", action: "none", safeReason: null }, eligibleModelIds: ["sonnet"], usage: { kind: "managed_credit", state: "current", currency: "USD", credit: {reservedMicrousd: 0, remainingBalanceMicrousd: 100000}, budget: {reservedThisMonthMicrousd: 0} } });
const props = { policy: { accessSourceId: "a", topUpEnabled: true, allowedModelIds: ["sonnet"], monthlyBudgetMicrousd: null }, provider: {id: "anthropic", displayName: "Anthropic", models: [{id: "sonnet", displayName: "Sonnet", enabled: true}]}, disabled: false, canSetBudget: false, canSetAllowlist: false, canAddCredit: true, onMutate: vi.fn(), onRefresh: vi.fn(), onUseGateway: vi.fn() };
it.each([false, true])("ignores stale checkout settlement after the source switches (rejection: %s)", async rejected => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const onAddCredit = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
  const view = render(<GatewayPanel {...props as Omit<React.ComponentProps<typeof GatewayPanel>, "source" | "onAddCredit">} source={source("a") as never} onAddCredit={onAddCredit} />);
  fireEvent.click(screen.getByRole("button", {name: "Buy credit"}));
  fireEvent.click(screen.getByRole("button", {name: "Continue to checkout"}));
  expect(onAddCredit).toHaveBeenCalledOnce();
  view.rerender(<GatewayPanel {...props as Omit<React.ComponentProps<typeof GatewayPanel>, "source" | "onAddCredit">} source={source("b") as never} onAddCredit={onAddCredit} />);
  fireEvent.click(screen.getByRole("button", {name: "Buy credit"}));
  await act(async () => { if (rejected) reject(new Error("private checkout failure")); else resolve(); });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText("Checkout could not be opened. Try again.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Continue to checkout"})).toBeEnabled();
});

it("wires history to the current scope and keeps agent selection out of the overview", async () => {
  const snapshot = { refreshedAt: "2026-10-04T00:00:00Z", access: {mode: "writable"}, supportedActions: [], configurationHarnessKinds: [], gatewayPolicy: null, modelProviders: [], accounts: [], accessSources: [], harnesses: [] } as unknown as ProviderSettingsSnapshot;
  const load = vi.fn().mockResolvedValue({entries: [], nextCursor: null});
  const base = {snapshot, selectedHarnessId: null, onSelectHarness: vi.fn(), onRefresh: vi.fn(), onMutate: vi.fn(), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn()};
  const view = render(<AgentsProvidersView {...base} onLoadUsageHistory={load} />);
  const overview = screen.getByRole("region", {name: "Matrix AI"});
  expect(within(overview).getByRole("button", {name: "Buy credit"})).toBeEnabled();
  expect(within(overview).queryByRole("button", {name: /Choose (OpenCode|Pi)/})).not.toBeInTheDocument();
  fireEvent.click(within(overview).getByRole("button", {name: "Usage history"}));
  await screen.findByText("No activity yet");
  expect(load).toHaveBeenCalledWith(null, expect.any(AbortSignal));
  const newLoad = vi.fn().mockResolvedValue({entries: [], nextCursor: null});
  view.rerender(<AgentsProvidersView {...base} onLoadUsageHistory={newLoad} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(newLoad).not.toHaveBeenCalled();
});

it("keeps configured agent choices in Advanced while Buy credit stays in the overview", () => {
  const onChoose = vi.fn();
  render(<GatewayPanel {...props as Omit<React.ComponentProps<typeof GatewayPanel>, "source" | "onAddCredit">} source={source("a") as never} onAddCredit={vi.fn()} onUseGateway={undefined}
    compatibleAgents={[{id: "opencode", displayName: "OpenCode"}, {id: "pi", displayName: "Pi"}]} onChooseAgent={onChoose} />);
  expect(screen.getByRole("button", {name: "Choose OpenCode"})).not.toBeVisible();
  expect(screen.getByRole("button", {name: "Choose Pi"})).not.toBeVisible();
  expect(screen.getByRole("button", {name: "Buy credit"})).toBeVisible();
  fireEvent.click(screen.getByText("Advanced Matrix AI settings"));
  fireEvent.click(screen.getByRole("button", {name: "Choose Pi"}));
  expect(onChoose).toHaveBeenCalledWith("pi");
});

it.each([false, true])('keeps a new pending checkout isolated from settlement of a former callback (rejection: %s)', async rejected => {
  let settleOld!: () => void; let rejectOld!: (error: Error) => void; let settleNew!: () => void;
  const oldSubmit = vi.fn(() => new Promise<void>((resolve, reject) => { settleOld = resolve; rejectOld = reject; }));
  const newSubmit = vi.fn(() => new Promise<void>(resolve => { settleNew = resolve; }));
  const shared = {...props as Omit<React.ComponentProps<typeof GatewayPanel>, 'source' | 'onAddCredit'>, source: source('same-id') as never};
  const view = render(<GatewayPanel {...shared} onAddCredit={oldSubmit} />);
  fireEvent.click(screen.getByRole('button', {name: 'Buy credit'}));
  fireEvent.click(screen.getByRole('button', {name: 'Continue to checkout'}));
  view.rerender(<GatewayPanel {...shared} onAddCredit={newSubmit} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Buy credit'}));
  fireEvent.click(screen.getByRole('button', {name: 'Continue to checkout'}));
  await act(async () => { if (rejected) rejectOld(new Error('fixture-private-old-checkout')); else settleOld(); });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Opening checkout…'})).toBeDisabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(newSubmit).toHaveBeenCalledOnce();
  await act(async () => { settleNew(); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
