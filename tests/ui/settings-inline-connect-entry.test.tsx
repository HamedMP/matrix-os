// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
