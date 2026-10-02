// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";

afterEach(cleanup);
function fixture(): ProviderSettingsSnapshot {
  return { harnesses: [{ id: "codex", harness: "codex", displayName: "Codex", installState: "installed", authState: "unknown", connectivity: "online", enabled: true, configuredEnabled: true, accessSourceId: null, accountIds: [], selectedAccountId: null, loginMethods: ["terminal"], route: { kind: "fixed", providerId: "openai", modelId: "selected-in-codex" } }], accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: "2026-10-01T00:00:00Z" } as unknown as ProviderSettingsSnapshot;
}
function props() { return { snapshot: fixture(), selectedHarnessId: "codex", onSelectHarness: vi.fn(), onMutate: vi.fn(), onRefresh: vi.fn(), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn(), onAddCredit: vi.fn(), onSetupHarness: vi.fn().mockResolvedValue(true) }; }
it("keeps the new Codex chooser when guided workflows are unavailable and preserves legacy controls behind disclosure", async () => {
  const p = props();
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  expect(screen.getByText("Connect Codex with")).toBeInTheDocument();
  const account = screen.getByRole("button", { name: /ChatGPT account Recommended/ });
  expect(screen.getByRole("button", { name: /API key/ })).toBeDisabled();
  expect(account).toBeDisabled();
  fireEvent.click(account);
  expect(p.onSetupHarness).not.toHaveBeenCalled();
  expect(screen.getByText("Advanced configuration").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByRole("heading", { name: "Choose the model", hidden: true })).not.toBeVisible();
});
it("uses the same two choices for a supported guided Codex connection without duplicate account setup", async () => {
  const p = props();
  const client = { capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false }]), start: vi.fn().mockResolvedValue({ id: "login", harnessInstanceId: "codex", kind: "login", state: "running", expiresAt: new Date(Date.now() + 60000).toISOString(), deviceCode: "test", authorizationUrl: null, terminalSessionId: null }), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  render(<AgentsProvidersView {...p} workflowClient={client as never} />);
  await waitFor(() => expect(client.capabilities).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  const account = await screen.findByRole("button", { name: /ChatGPT account Recommended/ });
  expect(screen.getAllByText("Connect Codex with")).toHaveLength(1);
  fireEvent.click(account);
  await waitFor(() => expect(client.start).toHaveBeenCalledWith(expect.objectContaining({ harnessInstanceId: "codex", kind: "login" }), expect.any(AbortSignal)));
  expect(p.onSetupHarness).not.toHaveBeenCalled();
});
it("retains a missing OpenClaw catalog row without fabricating a guided workflow target", async () => {
  const p = props();
  p.snapshot.harnessCatalog = [{ harness: "openclaw", displayName: "OpenClaw", installState: "missing", available: true, runnable: false, setupAction: "install", safeReason: "not_installed" }];
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /OpenClaw.*Not installed/ }));
  fireEvent.click(screen.getByRole("button", { name: "Install in Terminal" }));
  await waitFor(() => expect(p.onSetupHarness).toHaveBeenCalledWith("openclaw"));
  expect(p.onMutate).not.toHaveBeenCalled();
});
it("omits separate Hermes enable before connecting an account", () => {
  const p = props();
  Object.assign(p.snapshot.harnesses[0]!, { id: "hermes", harness: "hermes", displayName: "Hermes", enabled: false, configuredEnabled: false, route: { kind: "configurable", providerId: "anthropic", modelId: "test" } });
  p.snapshot.configurationHarnessKinds = ["hermes"];
  p.snapshot.supportedActions = ["set_harness_enabled"];
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(p.onMutate).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Connect Hermes in Terminal" })).not.toBeInTheDocument();
  expect(screen.getByText(/Connection in Settings is unavailable/)).toBeInTheDocument();
});
it("keeps owner-only connections disabled without persistent prose and recovers capabilities", async () => {
  const { ProviderWorkflowClientError } = await import("../../packages/ui/src/agents-providers/provider-workflow-client");
  const p = props();
  const denied = new ProviderWorkflowClientError("forbidden");
  denied.message = "private upstream details /home/owner/token";
  const client = { capabilities: vi.fn().mockRejectedValue(denied), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  const { rerender } = render(<AgentsProvidersView {...p} workflowClient={client} />);
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /ChatGPT account Recommended/ })).toHaveAttribute("title", "Only this computer’s owner can manage connections."));
  expect(screen.queryByText("Only this computer’s owner can manage connections.")).not.toBeInTheDocument();
  expect(screen.queryByText(/private upstream/)).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Agents & providers" })).toBeVisible();
  client.capabilities.mockResolvedValue([]);
  rerender(<AgentsProvidersView {...p} snapshot={{ ...p.snapshot, refreshedAt: "2026-10-02T00:00:00Z" }} workflowClient={client} />);
  await waitFor(() => expect(screen.queryByText("Only this computer’s owner can manage connections.")).not.toBeInTheDocument());
  expect(screen.getByText("Connection in Settings is unavailable on this computer. Refresh or update the computer to try again.")).toBeInTheDocument();
});
