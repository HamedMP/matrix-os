// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
afterEach(cleanup);
it("opens the current agent's Settings chooser when Own account has no bound native target", async () => {
  const snapshot = { harnesses: [{ id: "opencode", harness: "opencode", displayName: "OpenCode", installState: "installed", authState: "unknown", connectivity: "online", enabled: true, configuredEnabled: true, configuredAccessSourceId: null, accessSourceId: null, accountIds: [], selectedAccountId: null, loginMethods: [], route: { kind: "configurable", providerId: "openai", modelId: "test" } }], accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: ["opencode"], atomicConnectSupported: true, supportedActions: ["set_route"], access: { mode: "writable" }, refreshedAt: "2026-10-02T00:00:00Z" } as unknown as ProviderSettingsSnapshot;
  const client = { capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "opencode", harness: "opencode", displayName: "OpenCode", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false }]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  const onSetupHarness = vi.fn(); const onMutate = vi.fn();
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId="opencode" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={onMutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} onSetupHarness={onSetupHarness} workflowClient={client as never} />);
  await waitFor(() => expect(client.capabilities).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /^OpenCode/ }));
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  const choice = await screen.findByRole("button", { name: /Provider account/ });
  expect(choice).toHaveFocus();
  expect(client.start).not.toHaveBeenCalled();
  expect(onSetupHarness).not.toHaveBeenCalled();
  expect(onMutate).not.toHaveBeenCalled();
});

it("does not offer a Terminal Connect fallback when guided connections are owner-forbidden", async () => {
  const { ProviderWorkflowClientError } = await import("../../packages/ui/src/agents-providers/provider-workflow-client");
  const snapshot = { harnesses: [{ id: "hermes", harness: "hermes", displayName: "Hermes", installState: "installed", authState: "unknown", connectivity: "unknown", enabled: true, configuredEnabled: true, configuredAccessSourceId: null, accessSourceId: null, accountIds: [], selectedAccountId: null, loginMethods: [], route: { kind: "configurable", providerId: "openai-codex", modelId: "test" } }], accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: "2026-10-02T00:00:00Z" } as unknown as ProviderSettingsSnapshot;
  const client = { capabilities: vi.fn().mockRejectedValue(new ProviderWorkflowClientError("forbidden")), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  const onSetupHarness = vi.fn();
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId="hermes" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} onSetupHarness={onSetupHarness} workflowClient={client as never} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  await waitFor(() => expect(client.capabilities).toHaveBeenCalled());
  expect(screen.queryByText("Only this computer’s owner can manage connections.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Connect Hermes/ })).not.toBeInTheDocument();
  expect(onSetupHarness).not.toHaveBeenCalled();
});

it("preserves a visited agent's method and draft when another agent opens Connect", async () => {
  const row = (harness: "opencode" | "pi") => ({id: harness, harness, displayName: harness === "pi" ? "Pi" : "OpenCode", installState: "installed", authState: "unknown", connectivity: "online", enabled: true, configuredEnabled: true, accessSourceId: null, accountIds: [], selectedAccountId: null, loginMethods: [], route: {kind: "configurable", providerId: "openai", modelId: "test"}});
  const snapshot = {harnesses: [row("opencode"), row("pi")], accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: ["opencode", "pi"], atomicConnectSupported: true, supportedActions: ["set_route"], access: {mode: "writable"}, refreshedAt: "2026-10-04T00:00:00Z"} as unknown as ProviderSettingsSnapshot;
  const client = {capabilities: vi.fn().mockResolvedValue(snapshot.harnesses.map(item => ({harnessInstanceId: item.id, harness: item.harness, displayName: item.displayName, installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false}))), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn()};
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId="opencode" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} workflowClient={client as never} />);
  await waitFor(() => expect(client.capabilities).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", {name: /^OpenCode/}));
  fireEvent.click(screen.getAllByText("Advanced configuration").find(item => !item.closest("[inert]"))!);
  fireEvent.click(screen.getByRole("button", {name: /Own account/}));
  await waitFor(() => expect(screen.getByRole("button", {name: /Own account/})).toBeEnabled());
  fireEvent.click(await screen.findByRole("button", {name: /^API key/}));
  const input = screen.getByLabelText("Paste your OpenAI API key");
  fireEvent.change(input, {target: {value: "fixture-draft"}});
  fireEvent.click(screen.getByRole("button", {name: /^Pi/}));
  fireEvent.click(screen.getAllByText("Advanced configuration").find(item => !item.closest("[inert]"))!);
  fireEvent.click(screen.getByRole("button", {name: /Own account/}));
  await waitFor(() => expect(screen.getByRole("button", {name: /Own account/})).toBeEnabled());
  fireEvent.click(screen.getByRole("button", {name: /^OpenCode/}));
  expect(screen.getByLabelText("Paste your OpenAI API key")).toBe(input);
  expect(input).toHaveValue("fixture-draft");
  expect(client.submitKey).not.toHaveBeenCalled();
});

it.each([true, false])("retains only advertised unsupported login inside Advanced (advertised=%s)", async advertised => {
  const snapshot = { harnesses: [{ id: "hermes", harness: "hermes", displayName: "Hermes", installState: "installed", authState: "unauthenticated", connectivity: "online", enabled: false, accountIds: [], selectedAccountId: null, accessSourceId: null, loginMethods: ["terminal"], recommendedLoginMethod: "terminal", route: { kind: "configurable", providerId: "anthropic", modelId: "test" } }], accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: ["hermes"], supportedActions: advertised ? ["start_login"] : [], access: { mode: "writable" }, refreshedAt: "2026-10-04T00:00:00Z" } as unknown as ProviderSettingsSnapshot;
  const mutate = vi.fn();
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId="hermes" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={mutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  const summary = screen.getByText("Advanced configuration");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(summary);
  if (advertised) {
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith({ type: "start_login", harnessInstanceId: "hermes", accountId: null, method: "terminal" }));
  } else {
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  }
});


it("opens Own account after more than 32 removed agent IDs on the same connection", async () => {
  const row = (id: string) => ({ id, harness: "opencode", displayName: `OpenCode ${id}`, installState: "installed", authState: "unknown", connectivity: "online", enabled: true, configuredEnabled: true, configuredAccessSourceId: null, accessSourceId: null, accountIds: [], selectedAccountId: null, loginMethods: [], route: { kind: "configurable", providerId: "openai", modelId: "test" } });
  const snapshot = (id: string, index: number, retainRows = false) => ({ harnesses: retainRows ? Array.from({ length: index }, (_, position) => row(`agent-${position}`)) : [row(id)], accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: ["opencode"], supportedActions: ["set_route"], access: { mode: "writable" }, refreshedAt: `2026-10-04T00:00:${String(index).padStart(2, "0")}Z` }) as unknown as ProviderSettingsSnapshot;
  const client = { capabilities: vi.fn().mockResolvedValue([]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  const props = { onSelectHarness: vi.fn(), onRefresh: vi.fn(), onMutate: vi.fn(), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn(), workflowClient: client as never };
  const view = render(<AgentsProvidersView {...props} snapshot={snapshot("agent-0", 0)} selectedHarnessId="agent-0" />);
  for (let index = 0; index < 33; index++) {
    const id = `agent-${index}`;
    client.capabilities.mockResolvedValue([{ harnessInstanceId: id, harness: "opencode", displayName: `OpenCode ${id}`, installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false }]);
    view.rerender(<AgentsProvidersView {...props} snapshot={snapshot(id, index + 1, true)} selectedHarnessId={id} />);
    await waitFor(() => expect(client.capabilities).toHaveBeenCalledTimes(index + 2));
    fireEvent.click(document.getElementById(`matrix-ap-details-${id}-trigger`)!);
    const panel = within(document.getElementById(`matrix-ap-details-${id}`)!);
    await panel.findByRole("button", { name: /Provider account/ });
    const summary = panel.getByText("Advanced configuration");
    if (!summary.closest("details")?.hasAttribute("open")) fireEvent.click(summary);
    fireEvent.click(panel.getByRole("button", { name: /Own account/ }));
    if (index < 32) {
      await waitFor(() => expect(panel.getByRole("button", { name: /Provider account/ }), id).toHaveFocus());
    } else {
      await panel.findByRole("alert");
      expect(panel.getByText("Connection could not be updated. Try again.")).toBeInTheDocument();
      expect(panel.getByRole("button", { name: /Provider account/ })).not.toHaveFocus();
      view.rerender(<AgentsProvidersView {...props} snapshot={snapshot(id, 34)} selectedHarnessId={id} />);
      await waitFor(() => expect(client.capabilities).toHaveBeenCalledTimes(35));
      fireEvent.click(panel.getByRole("button", { name: /Own account/ }));
      await waitFor(() => expect(panel.getByRole("button", { name: /Provider account/ })).toHaveFocus());
    }
  }
  expect(client.start).not.toHaveBeenCalled();
  expect(props.onMutate).not.toHaveBeenCalled();
}, 60_000);
