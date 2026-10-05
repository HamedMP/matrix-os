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

it.each([
  ['policy', {policy: {...props.policy, topUpEnabled: false}}, 'Credit purchases are not enabled for this computer. Contact your workspace administrator or support.', false],
  ['permission', {canAddCredit: false}, 'Your current access does not allow credit purchases. Ask this computer’s owner to buy credit.', false],
  ['restricted funding', {source: {...source('a'), readiness: {state: 'unavailable', safeReason: 'policy', action: 'contact_owner'}}}, 'Matrix AI is restricted by your workspace. Ask your administrator to review access.', false],
  ['stale balance', {source: {...source('a'), usage: {...source('a').usage, state: 'stale'}}}, 'The current credit balance could not be confirmed. Refresh to check purchase availability.', true],
  ['missing funding', {source: null}, 'Purchase availability has not been confirmed for this computer. Refresh to check again.', true],
  ['reserved funding', {source: {...source('a'), readiness: {state: 'unavailable', safeReason: 'credit_reserved', action: 'retry'}}}, 'Credit usage is still being confirmed. Wait for it to finish, then check again.', true],
  ['unavailable funding', {source: {...source('a'), readiness: {state: 'unavailable', safeReason: 'provider_unavailable', action: 'retry'}}}, 'This funding source is unavailable for credit purchases. Contact support if the problem continues.', true],
] as const)('explains unavailable checkout inside the dialog with useful recovery: %s', (_name, overrides, message, refreshable) => {
  const onRefresh = vi.fn(); const onAddCredit = vi.fn();
  render(<GatewayPanel {...props as Omit<React.ComponentProps<typeof GatewayPanel>, 'source' | 'onAddCredit'>} source={source('a') as never} {...overrides as unknown as Partial<React.ComponentProps<typeof GatewayPanel>>} onRefresh={onRefresh} onAddCredit={onAddCredit} />);
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Buy credit'}));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(message)).toBeVisible();
  const refresh = within(dialog).queryByRole('button', {name: 'Check again'});
  expect(Boolean(refresh)).toBe(refreshable);
  if (refresh) {fireEvent.click(refresh); expect(onRefresh).toHaveBeenCalledOnce();}
  expect(within(dialog).queryByRole('button', {name: 'Continue to checkout'})).not.toBeInTheDocument();
  expect(onAddCredit).not.toHaveBeenCalled();
});

it.each([[1, '$0.000001'], [4999, '$0.004999'], [9999, '$0.009999'], [0, '$0.00'], [10000, '$0.01']] as const)('shows exact positive sub-cent spendable credit (%s microUSD)', (amount, label) => {
  const current = source('a'); current.usage.credit.remainingBalanceMicrousd = amount;
  render(<GatewayPanel {...props as Omit<React.ComponentProps<typeof GatewayPanel>, 'source' | 'onAddCredit'>} source={current as never} onAddCredit={vi.fn()} />);
  expect(screen.getByText(label)).toBeVisible();
});
