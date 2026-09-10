// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccount, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AddHarnessDialog } from "../../packages/ui/src/agents-providers/AddHarnessDialog";
import { openProviderAgentSetup, ProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { AccountsPanel } from "../../packages/ui/src/agents-providers/AccountsPanel";
import { RemovalDialog } from "../../packages/ui/src/agents-providers/RemovalDialog";
import { openWebProviderAgentSetup } from "../../shell/src/lib/provider-settings-transport";

function snapshot(): ProviderSettingsSnapshot {
  return {
    contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
    revision: 1, refreshedAt: "2026-09-06T00:00:00.000Z", access: { mode: "writable" },
    supportedActions: ["add_harness"], configurationHarnessKinds: ["pi"],
    harnessCatalog: [{ harness: "pi", displayName: "Pi", installState: "installed", available: true,
      runnable: true, setupAction: "none", safeReason: null },
      ...(["openclaw", "hermes", "opencode"] as const).map((harness) => ({ harness, displayName: harness,
        installState: "missing" as const, available: false, runnable: false, setupAction: "none" as const, safeReason: "runtime_not_supported" as const }))],
    harnesses: [], accounts: [],
    modelProviders: [{ id: "anthropic", displayName: "Anthropic", models: [{ id: "sonnet", displayName: "Sonnet", enabled: true }] }],
    accessSources: [{ id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null,
      displayName: "Matrix AI", eligibleModelIds: ["sonnet"],
      readiness: { state: "ready", checkedAt: "2026-09-06T00:00:00.000Z", staleAfter: null, safeReason: null, action: "none" },
      usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "owner_entitlement", reason: "ledger_not_available", asOf: "2026-09-06T00:00:00.000Z" } }],
    gatewayPolicy: { accessSourceId: "matrix_included", monthlyBudgetMicrousd: 1_000_000, allowedModelIds: ["sonnet"], topUpEnabled: false },
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("guided provider setup", () => {
  it("guides agent, connection and model choices without showing advanced customization", () => {
    render(<AddHarnessDialog snapshot={snapshot()} onMutate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Add agent" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Use AI through")).toHaveValue("matrix_included");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Model")).toHaveValue("sonnet");
  });

  it("opens supported setup visibly and waits for a refreshed installed state", async () => {
    const value = snapshot();
    value.harnessCatalog[0] = { ...value.harnessCatalog[0]!, installState: "missing", runnable: false, setupAction: "install", safeReason: "not_installed" };
    const onSetupHarness = vi.fn().mockResolvedValue(true);
    render(<AddHarnessDialog snapshot={value} onMutate={vi.fn()} onClose={vi.fn()} onSetupHarness={onSetupHarness} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Install Pi in Terminal" }));
    await waitFor(() => expect(onSetupHarness).toHaveBeenCalledWith("pi"));
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("retains the dialog and draft on failed add and closes only on confirmed success", async () => {
    const onClose = vi.fn();
    const onMutate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<AddHarnessDialog snapshot={snapshot()} onMutate={onMutate} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not saved"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Model")).toHaveValue("sonnet");
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("does not offer an unfunded Matrix source as a ready connection", () => {
    const value = snapshot();
    value.accessSources[0]!.readiness = { ...value.accessSources[0]!.readiness, state: "unavailable", action: "none", safeReason: "policy" } as typeof value.accessSources[0]["readiness"];
    render(<AddHarnessDialog snapshot={value} onMutate={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText(/Matrix AI is not ready on this computer/)).toBeInTheDocument();
  });

  it("does not silently change the funding source when a selected connection disappears", () => {
    const value = snapshot();
    value.accessSources.push({ ...value.accessSources[0]!, id: "owner_anthropic_key", kind: "provider_account", fundingKind: "owner_api_key", accountId: "owner_account", displayName: "My API key" });
    const props = { onMutate: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<AddHarnessDialog {...props} snapshot={value} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Use AI through"), { target: { value: "owner_anthropic_key" } });
    rerender(<AddHarnessDialog {...props} snapshot={snapshot()} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByLabelText("Use AI through")).toHaveValue("");
  });

  it("pins the displayed connection when continuing to the model step", () => {
    const value = snapshot();
    value.accessSources.push({ ...value.accessSources[0]!, id: "owner_anthropic_key", kind: "provider_account", fundingKind: "owner_api_key", accountId: "owner_account", displayName: "My API key" });
    const props = { onMutate: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<AddHarnessDialog {...props} snapshot={value} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    rerender(<AddHarnessDialog {...props} snapshot={{ ...value, accessSources: [value.accessSources[1]!], gatewayPolicy: null }} />);
    expect(screen.getByRole("button", { name: "Add agent" })).toBeDisabled();
  });
});

function canonicalCatalog(kind = "opencode", actionId = "opencode_connect") {
  return {
    revision: "setup_test", drivers: [{ kind, displayName: "Agent", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "agent_default", driverKind: kind, displayName: "Agent", availability: "setup_required",
      workspaceRequirement: "project_optional", catalogRevision: "setup_test", models: [], options: [], skills: [], commands: [],
      setupActions: [{ id: actionId, kind: "foreground_terminal", label: "Connect agent", command: "sh -lc 'opencode'" }],
      supports: { rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false,
        userInput: false, worktrees: "optional", resources: [], interactionModes: [], permissionModes: [] } }],
  };
}

describe("server-advertised setup dispatch", () => {
  it("opens only the selected agent's canonical command", async () => {
    const openCommand = vi.fn().mockResolvedValue(true);
    await expect(openProviderAgentSetup({ harness: "opencode", getCatalog: async () => canonicalCatalog(), openCommand })).resolves.toBe(true);
    expect(openCommand).toHaveBeenCalledWith("sh -lc 'opencode'");
  });

  it("maps Claude to its canonical claude_code driver and claude action prefix", async () => {
    const openCommand = vi.fn().mockResolvedValue(true);
    await expect(openProviderAgentSetup({ harness: "claude", getCatalog: async () => canonicalCatalog("claude_code", "claude_connect"), openCommand })).resolves.toBe(true);
    expect(openCommand).toHaveBeenCalledOnce();
  });

  it.each([null, { revision: "invalid" }, canonicalCatalog("opencode", "claude_connect"), canonicalCatalog("codex", "codex_connect")])(
    "rejects invalid catalog or unmatched agent/action",
    async (catalog) => {
      const openCommand = vi.fn();
      await expect(openProviderAgentSetup({ harness: "opencode", getCatalog: async () => catalog, openCommand })).resolves.toBe(false);
      expect(openCommand).not.toHaveBeenCalled();
    },
  );

  it("does not treat a missing setup command as success", async () => {
    const catalog = canonicalCatalog();
    catalog.instances[0]!.setupActions = [];
    const openCommand = vi.fn();
    await expect(openProviderAgentSetup({ harness: "opencode", getCatalog: async () => catalog, openCommand })).resolves.toBe(false);
    expect(openCommand).not.toHaveBeenCalled();
  });

  it("reports both failed and rejected Terminal opens safely", async () => {
    const openCommand = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("private-path"));
    const input = { harness: "opencode" as const, getCatalog: async () => canonicalCatalog(), openCommand };
    await expect(openProviderAgentSetup(input)).resolves.toBe(false);
    await expect(openProviderAgentSetup(input)).resolves.toBe(false);
  });

  it("creates and opens the server-confirmed visible Web Terminal session", async () => {
    const workspaceId = "tws_00000000000000000000000000000001";
    const tabId = "tt_00000000000000000000000000000001";
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(canonicalCatalog()))
      .mockResolvedValueOnce(Response.json({ workspace: { id: workspaceId } }))
      .mockResolvedValueOnce(Response.json({ tab: { id: tabId } }));
    vi.stubGlobal("fetch", fetcher);
    const onOpenTerminal = vi.fn();
    await expect(openWebProviderAgentSetup("opencode", onOpenTerminal)).resolves.toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(2, expect.stringContaining("/api/terminal/workspaces/ensure"), expect.objectContaining({
      method: "POST", signal: expect.any(AbortSignal), body: "{}",
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, expect.stringContaining(`/api/terminal/workspaces/${workspaceId}/tabs`), expect.objectContaining({
      method: "POST", signal: expect.any(AbortSignal), body: expect.stringContaining('"command":["sh","-lc","sh -lc \'opencode\'"]'),
    }));
    expect(onOpenTerminal).toHaveBeenCalledWith(`${workspaceId}:${tabId}`);
  });

  it("never opens an invalid returned Web Terminal reference", async () => {
    const workspaceId = "tws_00000000000000000000000000000001";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(canonicalCatalog()))
      .mockResolvedValueOnce(Response.json({ workspace: { id: workspaceId } }))
      .mockResolvedValueOnce(Response.json({ tab: { id: "../../secret" } })));
    const onOpenTerminal = vi.fn();
    await expect(openWebProviderAgentSetup("opencode", onOpenTerminal)).resolves.toBe(false);
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("does not start setup on another computer after a runtime switch", async () => {
    const original = window.location.pathname + window.location.search;
    window.history.replaceState({}, "", "/vm/preview-one?runtime=preview-one");
    const fetcher = vi.fn().mockImplementationOnce(async () => {
      window.history.replaceState({}, "", "/vm/preview-two?runtime=preview-two");
      return Response.json(canonicalCatalog());
    }).mockResolvedValueOnce(Response.json({ name: "setup-opencode-1234" }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(openWebProviderAgentSetup("opencode", vi.fn())).resolves.toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { window.history.replaceState({}, "", original); }
  });
});

describe("truthful account setup", () => {
  function props() {
    const harness = {
      id: "claude_default", harness: "claude" as const, displayName: "Claude", accentColor: null,
      enabled: true, version: null, installState: "installed" as const, authState: "unauthenticated" as const,
      loginMethods: ["terminal" as const], recommendedLoginMethod: "terminal" as const, connectivity: "online" as const,
      accountIds: [], selectedAccountId: null, accessSourceId: null,
      route: { kind: "fixed" as const, providerId: "anthropic", modelId: "sonnet" }, activeChatCount: 0,
    };
    return { harness, accounts: [], sources: [], allHarnesses: [harness], gatewayPolicy: null, attempt: null,
      disabled: false, canLogin: true, canLogout: false, canRemove: false, canReassign: false,
      onMutate: vi.fn().mockResolvedValue(true), onOpenTerminal: vi.fn(), onOpenBrowser: vi.fn() };
  }

  it("offers sign in but not unsupported additional account creation", () => {
    render(<AccountsPanel {...props()} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add account/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Additional isolated accounts are not supported/)).toBeInTheDocument();
  });

  it.each(["api_key", "oauth"] as const)("recovers an expired %s account through the advertised Terminal method", async (authMethod) => {
    const input = props();
    const account: ProviderAccount = { id: "personal", providerId: "anthropic", displayName: "Personal", authMethod,
      authState: "expired", lastCheckedAt: null, accessSourceId: "personal_source",
      dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } };
    const source = { ...snapshot().accessSources[0]!, id: account.accessSourceId, kind: "provider_account" as const,
      fundingKind: authMethod === "api_key" ? "owner_api_key" as const : "owner_account" as const, accountId: account.id };
    source.readiness = { ...source.readiness, state: "expired", action: "open_terminal" };
    render(<AccountsPanel {...input} accounts={[account]} sources={[source]} harness={{ ...input.harness, authState: "expired",
      connectivity: "unknown", accountIds: [account.id], selectedAccountId: account.id, accessSourceId: account.accessSourceId }} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(input.onMutate).toHaveBeenCalledWith({ type: "start_login", harnessInstanceId: "claude_default", accountId: null, method: "terminal" }));
    expect(screen.queryByRole("button", { name: /Add account/ })).not.toBeInTheDocument();
  });

  it("refreshes removal dependencies after a conflict and requires review before retry", async () => {
    const input = props();
    input.onMutate.mockResolvedValue(false);
    const account: ProviderAccount = { id: "personal", providerId: "anthropic", displayName: "Personal", authMethod: "terminal",
      authState: "authenticated", lastCheckedAt: null, accessSourceId: "personal_source",
      dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } };
    const value = snapshot();
    const shared = { ...input, sources: value.accessSources, gatewayPolicy: value.gatewayPolicy, canRemove: true, canReassign: true };
    const { rerender } = render(<AccountsPanel {...shared} accounts={[account]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Personal" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not saved"));
    const refreshed = { ...account, dependencies: { activeChatCount: 2, resumableChatCount: 1, harnessInstanceCount: 0 } };
    rerender(<AccountsPanel {...shared} accounts={[refreshed]} />);
    expect(screen.getByText(/2 active chats/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reassign dependencies" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm updated dependencies" }));
    fireEvent.click(screen.getByRole("button", { name: "Reassign dependencies" }));
    await waitFor(() => expect(input.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "reassign_account", dependencyGuard: refreshed.dependencies,
    })));
    rerender(<AccountsPanel {...shared} accounts={[]} />);
    expect(screen.queryByRole("dialog", { name: "Remove Personal" })).not.toBeInTheDocument();
  });

  it("keeps one-click sign in available when starting authentication fails", async () => {
    const input = props();
    input.onMutate.mockResolvedValue(false);
    render(<AccountsPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be updated"));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("keeps one visible native setup action for an authenticated generic agent", async () => {
    const input = props();
    const onSetupHarness = vi.fn().mockResolvedValue(true);
    render(<AccountsPanel {...input} harness={{ ...input.harness, harness: "opencode", displayName: "OpenCode",
      authState: "authenticated", loginMethods: [], recommendedLoginMethod: null }} canLogin={false} onSetupHarness={onSetupHarness} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenCode" }));
    await waitFor(() => expect(onSetupHarness).toHaveBeenCalledWith("opencode"));
    expect(screen.getAllByRole("button", { name: "Connect OpenCode" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Add account/ })).not.toBeInTheDocument();
  });

  it("offers retry for failed authentication and opens the returned Terminal attempt", async () => {
    const input = props();
    const { rerender } = render(<AccountsPanel {...input} attempt={{ id: "attempt", harnessInstanceId: "claude_default", accountId: null,
      method: "terminal", state: "failed", action: { kind: "retry" }, expiresAt: "2026-09-07T00:00:00.000Z", safeFailure: "unknown" }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry sign in" })); });
    expect(input.onMutate).toHaveBeenCalledWith(expect.objectContaining({ type: "start_login", method: "terminal" }));
    rerender(<AccountsPanel {...input} attempt={{ id: "attempt", harnessInstanceId: "claude_default", accountId: null,
      method: "terminal", state: "pending", action: { kind: "open_terminal", terminalSessionId: "login-claude" }, expiresAt: "2026-09-07T00:00:00.000Z", safeFailure: null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
    expect(input.onOpenTerminal).toHaveBeenCalledWith("login-claude");
  });

  it("retries an obsolete login method through supported Terminal signin", async () => {
    const input = props();
    render(<AccountsPanel {...input} attempt={{ id: "attempt", harnessInstanceId: "claude_default", accountId: "personal",
      method: "api_key", state: "expired", action: { kind: "retry" }, expiresAt: "2026-09-07T00:00:00.000Z", safeFailure: "unknown" }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry sign in" })); });
    expect(input.onMutate).toHaveBeenCalledWith({ type: "start_login", harnessInstanceId: "claude_default", accountId: null, method: "terminal" });
  });

  it("retains server-confirmed failed login for retry and clears it after successful authentication", async () => {
    let value = snapshot();
    value.harnesses = [props().harness];
    value.supportedActions = ["start_login"];
    const controller = new ProviderSettingsController({ identityKey: "test", transport: {
      getSnapshot: async () => value,
      mutate: async () => ({ kind: "login_attempt", snapshot: { ...value, revision: 2, projectionOf: { ...value.projectionOf, revision: 2 } },
        attempt: { id: "attempt", harnessInstanceId: "claude_default", accountId: null, method: "terminal", state: "failed",
          action: { kind: "retry" }, expiresAt: "2026-09-07T00:00:00.000Z", safeFailure: "unknown" } }),
    } });
    await controller.refresh();
    expect(controller.getState().snapshot).not.toBeNull();
    await controller.mutate({ type: "start_login", harnessInstanceId: "claude_default", accountId: null, method: "terminal" });
    expect(controller.getState().connectionAttempt?.state).toBe("failed");
    value = { ...value, revision: 3, projectionOf: { ...value.projectionOf, revision: 3 },
      harnesses: [{ ...value.harnesses[0]!, authState: "authenticated" }] };
    await controller.refresh();
    expect(controller.getState().connectionAttempt).toBeNull();
    controller.dispose();
  });
});

it("retains failed account removal until the server confirms success", async () => {
  const onClose = vi.fn();
  const onMutate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<RemovalDialog account={{ id: "personal", providerId: "anthropic", displayName: "Personal", authMethod: "terminal",
    authState: "authenticated", lastCheckedAt: null, accessSourceId: "personal_source",
    dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } }}
    accounts={[]} sources={[]} harnesses={[]} gatewayPolicy={null} disabled={false} canRemove canReassign={false} onMutate={onMutate} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not saved"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("does not reassign dependent Hermes routes to unsupported Matrix AI", () => {
  const value = snapshot();
  render(<RemovalDialog account={{ id: "personal", providerId: "anthropic", displayName: "Personal", authMethod: "terminal",
    authState: "authenticated", lastCheckedAt: null, accessSourceId: "personal_source",
    dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } }}
    accounts={[]} sources={value.accessSources} harnesses={[{
      id: "hermes", harness: "hermes", displayName: "Hermes", accentColor: null, enabled: true, version: null,
      installState: "installed", authState: "authenticated", loginMethods: [], recommendedLoginMethod: null,
      connectivity: "online", accountIds: ["personal"], selectedAccountId: "personal", accessSourceId: "personal_source",
      route: { kind: "configurable", providerId: "anthropic", modelId: "sonnet" }, activeChatCount: 0,
    }]} gatewayPolicy={value.gatewayPolicy} disabled={false} canRemove canReassign onMutate={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole("option", { name: "Matrix AI" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reassign dependencies" })).toBeDisabled();
});

it("disables a reassignment target removed by a snapshot refresh", () => {
  const value = snapshot();
  const account: ProviderAccount = { id: "personal", providerId: "anthropic", displayName: "Personal", authMethod: "terminal",
    authState: "authenticated", lastCheckedAt: null, accessSourceId: "personal_source",
    dependencies: { activeChatCount: 1, resumableChatCount: 0, harnessInstanceCount: 0 } };
  const props = { account, accounts: [], harnesses: [], gatewayPolicy: value.gatewayPolicy,
    disabled: false, canRemove: true, canReassign: true, onMutate: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<RemovalDialog {...props} sources={value.accessSources} />);
  expect(screen.getByRole("button", { name: "Reassign dependencies" })).toBeEnabled();
  rerender(<RemovalDialog {...props} sources={[]} />);
  expect(screen.getByRole("button", { name: "Reassign dependencies" })).toBeDisabled();
});
