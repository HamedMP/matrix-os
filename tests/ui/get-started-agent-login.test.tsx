// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot, ProviderWorkflowCapability, ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { GetStartedAgentLogin, type GetStartedAgentLoginPort } from "../../packages/ui/src/get-started/agent-login.js";

afterEach(cleanup);

const claude: ProviderWorkflowCapability = { harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: true };
const codex: ProviderWorkflowCapability = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false };
const option = (id: string, method: "browser" | "terminal"): ProviderWorkflowConnectionOption => ({ id, providerId: "anthropic", authKind: "subscription", method, billingKind: "subscription", executionKind: "native", availability: "available" });

type Connection = { authMethod: "api_key" | "subscription" } | null;

function snapshot(connection: Connection = null, installState: "installed" | "missing" = "installed"): ProviderSettingsSnapshot {
  return {
    harnesses: [{ id: "claude", harness: "claude", displayName: "Claude Code", installState, authState: connection ? "authenticated" : "unauthenticated", connectivity: "online", enabled: true, configuredEnabled: true, accessSourceId: connection ? "src_1" : null, accountIds: connection ? ["acct_1"] : [], selectedAccountId: connection ? "acct_1" : null, loginMethods: ["browser"] }],
    accounts: connection ? [{ id: "acct_1", accessSourceId: "src_1", providerId: "anthropic", authMethod: connection.authMethod, authState: "authenticated", displayName: "sam@example.com" }] : [],
    accessSources: connection ? [{ id: "src_1", kind: "harness_profile", providerId: "anthropic", fundingKind: connection.authMethod === "api_key" ? "owner_api_key" : "owner_account", readiness: { state: "ready" }, usage: { kind: "unavailable" } }] : [],
    modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as ProviderSettingsSnapshot;
}

function port(overrides: Partial<GetStartedAgentLoginPort> = {}, capabilities: Promise<ProviderWorkflowCapability[]> = Promise.resolve([claude, codex])): GetStartedAgentLoginPort {
  const workflowClient = { capabilities: vi.fn(() => capabilities), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitCode: vi.fn(), submitKey: vi.fn(), logs: vi.fn() } as unknown as ProviderWorkflowClient;
  return { snapshot: snapshot(), failed: false, workflowClient, refresh: vi.fn(), openAuthorizationUrl: vi.fn(), ...overrides };
}

describe("GetStartedAgentLogin", () => {
  it("shows the Settings sign-in for the picked agent only", async () => {
    render(<GetStartedAgentLogin agent="claude" port={port()} />);
    expect(await screen.findByRole("region", { name: "Claude Code connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Claude account/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Codex connection" })).not.toBeInTheDocument();
  });

  it("never offers Terminal sign-in: the wizard cannot show Terminal", async () => {
    const both: ProviderWorkflowCapability = { ...claude, loginMethods: ["browser", "terminal"], connectionOptions: [option("claude_browser", "browser"), option("claude_terminal", "terminal")] } as ProviderWorkflowCapability;
    render(<GetStartedAgentLogin agent="claude" port={port({}, Promise.resolve([both]))} />);
    expect(await screen.findByRole("region", { name: "Claude Code connection" })).toBeInTheDocument();
    expect(screen.queryByText(/Log in in Terminal/)).not.toBeInTheDocument();
    cleanup();
    // With only a Terminal sign-in, the owner logs in later in Settings.
    render(<GetStartedAgentLogin agent="claude" port={port({}, Promise.resolve([{ ...claude, loginMethods: ["terminal"], apiKeyProviders: [] }]))} />);
    expect(await screen.findByText("You can log in to Claude Code later in Settings > Agents & providers.")).toBeInTheDocument();
  });

  it("installs an agent that is not on this computer yet, right here, with no Terminal", async () => {
    const missing: ProviderWorkflowCapability = { ...claude, installState: "missing", install: true };
    const login = port({ snapshot: snapshot(null, "missing") }, Promise.resolve([missing]));
    vi.mocked(login.workflowClient.start).mockResolvedValue({ id: "op_install", harnessInstanceId: "claude", kind: "install", state: "running", terminalSessionId: "term_1" } as never);
    vi.mocked(login.workflowClient.get).mockResolvedValue({ id: "op_install", harnessInstanceId: "claude", kind: "install", state: "running", terminalSessionId: "term_1" } as never);
    render(<GetStartedAgentLogin agent="claude" port={login} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Install/ }));
    expect(await screen.findByText("Installing Claude Code…")).toBeInTheDocument();
    expect(screen.getByText("This takes a minute or two. You can keep going; it finishes in the background.")).toBeInTheDocument();
    await waitFor(() => expect(login.workflowClient.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "install" }), expect.anything()));
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
  });

  it("shows a green Connected line that says how the agent is connected", async () => {
    const { rerender } = render(<GetStartedAgentLogin agent="claude" port={port({ snapshot: snapshot({ authMethod: "api_key" }) })} />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change account" })).not.toBeInTheDocument();
    rerender(<GetStartedAgentLogin agent="claude" port={port({ snapshot: snapshot({ authMethod: "subscription" }) })} />);
    expect(await screen.findByText("Claude account · sam@example.com")).toBeInTheDocument();
  });

  it("disables sign-in on a read-only computer and says why, like Settings", async () => {
    const readOnly = { ...snapshot(), access: { mode: "read_only", reason: "remote_policy" } } as ProviderSettingsSnapshot;
    render(<GetStartedAgentLogin agent="claude" port={port({ snapshot: readOnly })} />);
    expect(await screen.findByRole("region", { name: "Claude Code connection" })).toBeInTheDocument();
    expect(screen.getByText("Your organization controls these settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Claude account/ })).toBeDisabled();
  });

  it("waits for this computer's provider state before offering a sign-in", () => {
    render(<GetStartedAgentLogin agent="claude" port={port({ snapshot: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking Claude Code…");
    expect(screen.queryByRole("button", { name: /Claude account/ })).not.toBeInTheDocument();
  });

  it("points to Settings when this computer cannot sign the agent in here", async () => {
    const { rerender } = render(<GetStartedAgentLogin agent="codex" port={port({}, Promise.resolve([claude]))} />);
    expect(await screen.findByText("You can log in to Codex later in Settings > Agents & providers.")).toBeInTheDocument();
    rerender(<GetStartedAgentLogin agent="claude" port={port({ snapshot: null, failed: true })} />);
    expect(await screen.findByText("You can log in to Claude Code later in Settings > Agents & providers.")).toBeInTheDocument();
    cleanup();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<GetStartedAgentLogin agent="claude" port={port({}, Promise.reject(new Error("offline")))} />);
    expect(await screen.findByText("You can log in to Claude Code later in Settings > Agents & providers.")).toBeInTheDocument();
  });
});
