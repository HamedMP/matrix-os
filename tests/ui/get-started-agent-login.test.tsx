// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot, ProviderWorkflowCapability } from "@matrix-os/contracts";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { GetStartedAgentLogin, type GetStartedAgentLoginPort } from "../../packages/ui/src/get-started/agent-login.js";

afterEach(cleanup);

const claude: ProviderWorkflowCapability = { harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: true };
const codex: ProviderWorkflowCapability = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false };

function snapshot(authState: "authenticated" | "unauthenticated"): ProviderSettingsSnapshot {
  return {
    harnesses: [{ id: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", authState, connectivity: "online", enabled: true, configuredEnabled: true, accessSourceId: null, accountIds: [], selectedAccountId: null, loginMethods: ["browser"], route: { kind: "fixed", providerId: "anthropic", modelId: "selected-in-claude" } }],
    accounts: [], accessSources: [], modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as ProviderSettingsSnapshot;
}

function port(overrides: Partial<GetStartedAgentLoginPort> = {}, capabilities: Promise<ProviderWorkflowCapability[]> = Promise.resolve([claude, codex])): GetStartedAgentLoginPort {
  const workflowClient = { capabilities: vi.fn(() => capabilities), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitCode: vi.fn(), submitKey: vi.fn(), logs: vi.fn() } as unknown as ProviderWorkflowClient;
  return { snapshot: snapshot("unauthenticated"), failed: false, workflowClient, refresh: vi.fn(), openAuthorizationUrl: vi.fn(), ...overrides };
}

describe("GetStartedAgentLogin", () => {
  it("shows the Settings sign-in for the picked agent only", async () => {
    render(<GetStartedAgentLogin agent="claude" port={port()} />);
    expect(await screen.findByRole("region", { name: "Claude Code connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Claude account/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Codex connection" })).not.toBeInTheDocument();
  });

  it("keeps a Terminal sign-in for Settings instead of opening Terminal behind the wizard", async () => {
    const terminalOnly: ProviderWorkflowCapability = { ...claude, loginMethods: ["terminal"], apiKeyProviders: [] };
    const login = port({}, Promise.resolve([terminalOnly]));
    vi.mocked(login.workflowClient.start).mockResolvedValue({ id: "op_1", harnessInstanceId: "claude", kind: "login", state: "running", terminalSessionId: "term_1" } as never);
    render(<GetStartedAgentLogin agent="claude" port={login} />);
    fireEvent.click(await screen.findByRole("button", { name: "Log in in Terminal" }));
    expect(await screen.findByText("This sign-in continues in Terminal. After setup, finish it in Settings > Agents & providers.")).toBeInTheDocument();
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
