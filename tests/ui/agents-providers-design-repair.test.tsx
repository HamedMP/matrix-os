// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
it("renders the connected card from source observation without a disabled connect chooser", () => {
  const p = props();
  const observed = { state: "present_unverified", observedAt: "2026-10-03T00:00:00Z", staleAfter: "2099-10-03T00:00:00Z" };
  p.snapshot.harnesses[0]!.selectedAccountId = "owner";
  p.snapshot.harnesses[0]!.accountIds = ["owner"];
  p.snapshot.accounts = [{ id: "owner", accessSourceId: "native", displayName: "owner@example.com", authState: "unknown", authMethod: "terminal", dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } }] as never;
  p.snapshot.accessSources = [{ id: "native", kind: "provider_account", eligibleModelIds: [], providerId: "openai", displayName: "owner@example.com", localObservation: observed, readiness: { state: "unknown" }, usage: { kind: "unavailable", reason: "unknown" } }] as never;
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  expect(screen.getByRole("button", { name: /Codex.*Connected/ })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Connection" })).toBeVisible();
  expect(screen.queryByText("Connect Codex with")).not.toBeInTheDocument();
  expect(screen.getAllByText("owner@example.com").some(node => !node.closest("details"))).toBe(true);
  expect(screen.getByRole("button", { name: "Change account" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check account again" })).toBeEnabled();
  expect(screen.queryByText("Your subscription or account")).not.toBeVisible();
});
it("shows negotiated plan and email with real remaining allowance and reset", async () => {
  const { ConnectedAccountCard } = await import("../../packages/ui/src/agents-providers/ConnectedAccountCard");
  const p = props();
  render(<ConnectedAccountCard harness={p.snapshot.harnesses[0]!} account={{ displayName: "Codex", authMethod: "terminal", connectionDetails: { planName: "ChatGPT Plus", email: "owner@example.com" } } as never} source={{ usage: { kind: "subscription_allowance", usedBasisPoints: 10000, resetsAt: "2026-10-04T00:00:00Z", asOf: "2026-10-03T00:00:00Z", state: "stale" } } as never} disabled={false} onRefresh={vi.fn()} action={<button>Change account</button>} />);
  expect(screen.getByText("ChatGPT Plus")).toBeVisible();
  expect(screen.getByText("owner@example.com")).toBeVisible();
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
  expect(screen.getByText(/Resets/)).toBeVisible();
  expect(screen.getByText(/Usage last confirmed/)).toBeVisible();
  expect(screen.queryByText("Selected")).not.toBeInTheDocument();
  expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
});
it("resolves only the chosen source account when canonical selection is unavailable", async () => {
  const { resolveHarnessConnection } = await import("../../packages/ui/src/agents-providers/harness-connection");
  const harness = { ...fixture().harnesses[0]!, accessSourceId: "chosen", selectedAccountId: null };
  const owner = { id: "owner", accessSourceId: "chosen", connectionDetails: { email: "owner@example.com", planName: "ChatGPT Plus" } } as never;
  const unrelated = { id: "other", accessSourceId: "other" } as never;
  const source = { id: "chosen", accountId: "owner" } as never;
  expect(resolveHarnessConnection(harness, [unrelated, owner], [source]).account).toBe(owner);
  expect(resolveHarnessConnection(harness, [unrelated], [source]).account).toBeUndefined();
  expect(resolveHarnessConnection({ ...harness, accessSourceId: "missing", selectedAccountId: "owner" }, [owner], [source]).account).toBeUndefined();
  expect(resolveHarnessConnection(harness, [owner, { id: "ambiguous", accessSourceId: "chosen" } as never], [{ id: "chosen", accountId: null } as never]).account).toBeUndefined();
});

it("wires source-linked native profile identity and quota into the connected page when selected account is unavailable", () => {
  const p = props();
  p.snapshot.harnesses[0]!.accessSourceId = "native";
  p.snapshot.harnesses[0]!.accountIds = ["native-owner"];
  p.snapshot.accounts = [{ id: "native-owner", providerId: "openai", accessSourceId: "native", displayName: "native@example.com", authMethod: "terminal", authState: "authenticated", connectionDetails: { email: "native@example.com", planName: "ChatGPT Pro" }, dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } },
    { id: "unrelated", providerId: "openai", accessSourceId: "other", displayName: "other@example.com", authMethod: "terminal", authState: "authenticated", connectionDetails: { email: "other@example.com", planName: "ChatGPT Plus" }, dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } }] as never;
  p.snapshot.accessSources = [{ id: "native", kind: "provider_account", providerId: "openai", accountId: "native-owner", displayName: "Codex account", localObservation: { state: "present_unverified", checkedAt: "2026-10-03T00:00:00Z", staleAfter: "2099-10-03T00:00:00Z" }, readiness: { state: "unknown" }, eligibleModelIds: [], usage: { kind: "subscription_allowance", authority: "provider_allowance", state: "current", scope: "account", usedBasisPoints: 2500, resetsAt: "2026-10-04T00:00:00Z", asOf: "2026-10-03T00:00:00Z" } }] as never;
  render(<AgentsProvidersView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: /^Codex.*Connected/ }));
  const card = within(screen.getByRole("region", { name: "Codex connection" }));
  expect(card.getByText("ChatGPT Pro")).toBeVisible();
  expect(card.getByText("native@example.com")).toBeVisible();
  expect(card.queryByText("other@example.com")).not.toBeInTheDocument();
  expect(card.queryByText("ChatGPT Plus")).not.toBeInTheDocument();
  expect(card.getByRole("progressbar")).toHaveAttribute("value", "7500");
  expect(card.getByText(/Resets/)).toBeVisible();
  expect(screen.queryByText("Connect Codex with")).not.toBeInTheDocument();
  expect(screen.queryByText(/5 hour|weekly/i)).not.toBeInTheDocument();
});
it("disconnects only the exact source-linked account when logout is advertised and selection is unresolved", async () => {
  const p = props();
  Object.assign(p.snapshot.harnesses[0]!, { authState: "authenticated", accessSourceId: "native", accountIds: ["owner"], selectedAccountId: null });
  p.snapshot.supportedActions = ["logout_account"];
  p.snapshot.accounts = [{ id: "owner", accessSourceId: "native", displayName: "Owner", authMethod: "terminal", dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } }] as never;
  p.snapshot.accessSources = [{ id: "native", accountId: "owner", eligibleModelIds: [], readiness: { state: "ready" }, usage: { kind: "unavailable", reason: "unknown" } }] as never;
  const client = { capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: true }]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  render(<AgentsProvidersView {...p} workflowClient={client as never} />);
  fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
  const disconnect = await screen.findByRole("button", { name: "Disconnect" });
  expect(disconnect).toBeEnabled();
  fireEvent.click(disconnect);
  const confirmation = screen.getByRole("dialog");
  fireEvent.click(confirmation.querySelector("button.matrix-ap-button-danger")!);
  await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith({ type: "logout_account", accountId: "owner" }));
});
