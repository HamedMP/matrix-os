// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { AccountsPanel } from "../../packages/ui/src/agents-providers/AccountsPanel";
import { ProviderWorkflowClientError } from "../../packages/ui/src/agents-providers/provider-workflow-client";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function snapshot(): ProviderSettingsSnapshot {
  const now = new Date().toISOString();
  return { refreshedAt: now, access: { mode: "writable" }, supportedActions: ["set_harness_enabled"], configurationHarnessKinds: ["pi"], accounts: [], gatewayPolicy: null, modelProviders: [],
    harnessCatalog: [{ harness: "pi", displayName: "Pi", available: true, runnable: true, installState: "installed", setupAction: "open_terminal", safeReason: null }],
    harnesses: [{ id: "pi", harness: "pi", displayName: "Pi", enabled: true, configuredEnabled: true, installState: "installed", authState: "unknown", loginMethods: [], connectivity: "online", accountIds: [], selectedAccountId: null, accessSourceId: "native_pi", route: { kind: "configurable", providerId: "anthropic", modelId: "test" } }],
    accessSources: [{ id: "native_pi", kind: "harness_profile", harness: "pi", providerId: "anthropic", accountId: null, fundingKind: "owner_account", displayName: "Pi account", eligibleModelIds: ["test"], localObservation: { state: "present_unverified", checkedAt: now, staleAfter: new Date(Date.now() + 5000).toISOString() }, readiness: { state: "unknown", checkedAt: now, staleAfter: null, action: "retry", safeReason: "unknown" }, usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "access_source", reason: "unknown", asOf: null } }] } as unknown as ProviderSettingsSnapshot;
}
function view(next = snapshot(), overrides: Partial<React.ComponentProps<typeof AgentsProvidersView>> = {}) {
  const mutate = vi.fn().mockResolvedValue(true); const refresh = vi.fn(); const setup = vi.fn().mockResolvedValue(true);
  render(<AgentsProvidersView snapshot={next} selectedHarnessId="pi" onSelectHarness={vi.fn()} onRefresh={refresh} onMutate={mutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onSetupHarness={setup} onAddCredit={vi.fn()} {...overrides} />);
  fireEvent.click(screen.getByRole("button", { name: /^Pi/ }));
  return { mutate, refresh, setup };
}
it("disconnects a non-guided saved agent without logging out or changing its route", async () => {
  const next = snapshot(); const before = structuredClone(next); const { mutate, refresh } = view(next);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "set_harness_enabled", harnessInstanceId: "pi", enabled: false });
  expect(next).toEqual(before);
  expect(screen.queryByRole("switch")).toBeNull();
});
it("retains the connection and reports a safe failed disable without refreshing", async () => {
  const mutate = vi.fn().mockRejectedValue(new Error("private path")); const { refresh } = view(snapshot(), { onMutate: mutate });
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent("private path");
  expect(refresh).not.toHaveBeenCalled();
});
it("does not invent a disable capability", () => {
  const next = snapshot(); next.supportedActions = []; view(next);
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
});
it("opens only an advertised Terminal setup inside collapsed Advanced", async () => {
  const { setup } = view(); const summary = screen.getByText("Advanced configuration");
  expect(summary.closest("details")).not.toHaveAttribute("open"); fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "Connect in Terminal" }));
  await waitFor(() => expect(setup).toHaveBeenCalledWith("pi"));
});
it("does not expose the Terminal setup after owner denial", async () => {
  const client = { capabilities: vi.fn().mockRejectedValue(new ProviderWorkflowClientError("forbidden")) };
  view(snapshot(), { workflowClient: client as never });
  await act(async () => {}); fireEvent.click(screen.getByText("Advanced configuration"));
  expect(screen.queryByRole("button", { name: "Connect in Terminal" })).toBeNull();
});
it("does not invent install support for a saved missing unsupported agent", () => {
  const next = snapshot(); next.harnesses[0]!.installState = "missing";
  Object.assign(next.harnessCatalog![0]!, { available: false, runnable: false, installState: "missing", setupAction: "none", safeReason: "runtime_not_supported" });
  view(next); expect(screen.queryByRole("button", { name: "Install in Terminal" })).toBeNull();
});
it.each(["off", "expired"] as const)("labels a native %s connection truthfully", async state => {
  vi.useFakeTimers(); const next = snapshot(); if (state === "off") next.harnesses[0]!.configuredEnabled = false;
  render(<AccountsPanel harness={next.harnesses[0]!} accounts={[]} sources={next.accessSources} allHarnesses={next.harnesses} gatewayPolicy={null} attempt={null} disabled={false} canLogin={false} canLogout={false} canRemove={false} canReassign={false} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} />);
  if (state === "expired") await act(() => vi.advanceTimersByTimeAsync(5001));
  expect(screen.getByTestId("native-account-pi")).toHaveTextContent("Not connected");
  expect(screen.getByText("Usage unavailable")).toBeVisible();
});

it("expires the rail label without a snapshot refresh", async () => {
  vi.useFakeTimers(); view();
  expect(screen.getByRole("button", { name: /^Pi/ })).toHaveTextContent("Connected");
  await act(() => vi.advanceTimersByTimeAsync(5001));
  expect(screen.getByRole("button", { name: /^Pi/ })).toHaveTextContent("Not connected");
});
it.each(["none", "unsupported"] as const)("does not open an unadvertised %s Terminal setup", mode => {
  const next = snapshot(); Object.assign(next.harnessCatalog![0]!, mode === "none" ? { setupAction: "none" } : { available: false, setupAction: "none", safeReason: "runtime_not_supported" });
  const { setup } = view(next); fireEvent.click(screen.getByText("Advanced configuration"));
  expect(screen.queryByRole("button", { name: "Connect in Terminal" })).toBeNull();
  expect(setup).not.toHaveBeenCalled();
});

it("retains one method-driven Advanced login when both recovery contracts exist", async () => {
  const next = snapshot(); next.supportedActions!.push("start_login");
  next.harnesses[0]!.loginMethods = ["terminal"];
  const { mutate, setup } = view(next);
  fireEvent.click(screen.getByText("Advanced configuration"));
  expect(screen.queryByRole("button", { name: "Connect in Terminal" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "start_login", harnessInstanceId: "pi", accountId: null, method: "terminal" }));
  expect(setup).not.toHaveBeenCalled();
});
