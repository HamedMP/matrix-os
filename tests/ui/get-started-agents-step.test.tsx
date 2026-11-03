// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot, ProviderWorkflowCapability, ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import type { GetStartedAgentLoginPort } from "../../packages/ui/src/get-started/agent-login.js";
import { GetStartedAgentsStep } from "../../packages/ui/src/get-started/agents-step.js";

afterEach(cleanup);

const claude: ProviderWorkflowCapability = { harnessInstanceId: "claude", harness: "claude", displayName: "Claude Code", installState: "installed", loginMethods: ["browser"], apiKeyProviders: ["anthropic"], install: false, uninstall: false, logs: true };
const codex: ProviderWorkflowCapability = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: ["openai"], install: false, uninstall: false, logs: false };
const option = (id: string, method: "browser" | "terminal"): ProviderWorkflowConnectionOption => ({ id, providerId: "anthropic", authKind: "subscription", method, billingKind: "subscription", executionKind: "native", availability: "available" });

type Connection = { authMethod: "api_key" | "subscription" } | null;

function creditSource(availableMicrousd: number, asOf: string) {
  return {
    id: "matrix_cloudflare", kind: "matrix_gateway", providerId: "cloudflare", fundingKind: "matrix_managed",
    readiness: { state: "ready", checkedAt: asOf }, eligibleModelIds: [],
    usage: {
      kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
      usedMicrousd: 0, remainingMicrousd: availableMicrousd, limitMicrousd: 50_000_000, periodStartedAt: asOf, resetsAt: null, asOf,
      credit: { promotionalBalanceMicrousd: availableMicrousd, addonBalanceMicrousd: 0, creditBalanceMicrousd: availableMicrousd, reservedMicrousd: 0, remainingBalanceMicrousd: availableMicrousd },
      budget: { monthlyBudgetMicrousd: 50_000_000, settledThisMonthMicrousd: 0, reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: 50_000_000 },
      chatAvailability: { asOf, eligibleBalanceMicrousd: availableMicrousd, availableBalanceMicrousd: availableMicrousd },
    },
  };
}

function snapshot({ connection = null, installState = "installed", sources = [] }: { connection?: Connection; installState?: "installed" | "missing"; sources?: unknown[] } = {}): ProviderSettingsSnapshot {
  return {
    harnesses: [{ id: "claude", harness: "claude", displayName: "Claude Code", installState, authState: connection ? "authenticated" : "unauthenticated", connectivity: "online", enabled: true, configuredEnabled: true, accessSourceId: connection ? "src_1" : null, accountIds: connection ? ["acct_1"] : [], selectedAccountId: connection ? "acct_1" : null, loginMethods: ["browser"] }],
    accounts: connection ? [{ id: "acct_1", accessSourceId: "src_1", providerId: "anthropic", authMethod: connection.authMethod, authState: "authenticated", displayName: "sam@example.com" }] : [],
    accessSources: [
      ...(connection ? [{ id: "src_1", kind: "harness_profile", providerId: "anthropic", fundingKind: connection.authMethod === "api_key" ? "owner_api_key" : "owner_account", readiness: { state: "ready" }, usage: { kind: "unavailable", reason: "not_reported" } }] : []),
      ...sources,
    ],
    modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: "2026-10-01T00:00:00Z",
  } as unknown as ProviderSettingsSnapshot;
}

function port(overrides: Partial<GetStartedAgentLoginPort> = {}, capabilities: Promise<ProviderWorkflowCapability[]> = Promise.resolve([claude, codex])): GetStartedAgentLoginPort {
  const workflowClient = { capabilities: vi.fn(() => capabilities), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), submitCode: vi.fn(), submitKey: vi.fn(), logs: vi.fn() } as unknown as ProviderWorkflowClient;
  return { snapshot: snapshot(), failed: false, workflowClient, refresh: vi.fn(), openAuthorizationUrl: vi.fn(), ...overrides };
}

function row(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

describe("Get started coding agents screen", () => {
  it("lists Claude Code and Codex as the Settings rows, collapsed, with their status", async () => {
    render(<GetStartedAgentsStep port={port()} onAgentsConnected={vi.fn()} />);
    const list = screen.getByRole("region", { name: "Coding agents" });
    expect(within(list).getByRole("heading", { name: "Coding agents" })).toBeInTheDocument();
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Not connected"));
    expect(row("Codex")).toHaveTextContent("Not connected");
    expect(row("Claude Code")).toHaveAttribute("aria-expanded", "false");
    expect(row("Codex")).toHaveAttribute("aria-expanded", "false");
    expect(list.querySelectorAll(".matrix-ap-agent-logo img")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Claude Code connection" })).not.toBeInTheDocument();
  });

  it("expands one row at a time into the Settings sign-in, and never offers Terminal", async () => {
    const both = { ...claude, loginMethods: ["browser", "terminal"], connectionOptions: [option("claude_browser", "browser"), option("claude_terminal", "terminal")] } as ProviderWorkflowCapability;
    render(<GetStartedAgentsStep port={port({}, Promise.resolve([both, codex]))} onAgentsConnected={vi.fn()} />);
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Not connected"));
    fireEvent.click(row("Claude Code"));
    expect(row("Claude Code")).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("region", { name: "Claude Code connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Claude account/ })).toBeInTheDocument();
    expect(screen.queryByText(/Log in in Terminal/)).not.toBeInTheDocument();
    fireEvent.click(row("Codex"));
    expect(row("Claude Code")).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByRole("region", { name: "Codex connection" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude Code connection" })).not.toBeInTheDocument();
    // Clicking the open row again closes it.
    fireEvent.click(row("Codex"));
    expect(row("Codex")).toHaveAttribute("aria-expanded", "false");
  });

  it("installs an agent that is not on this computer yet, right in its row, with no Terminal", async () => {
    const missing: ProviderWorkflowCapability = { ...claude, installState: "missing", install: true };
    const login = port({ snapshot: snapshot({ installState: "missing" }) }, Promise.resolve([missing, codex]));
    vi.mocked(login.workflowClient.start).mockResolvedValue({ id: "op_install", harnessInstanceId: "claude", kind: "install", state: "running", terminalSessionId: "term_1" } as never);
    vi.mocked(login.workflowClient.get).mockResolvedValue({ id: "op_install", harnessInstanceId: "claude", kind: "install", state: "running", terminalSessionId: "term_1" } as never);
    render(<GetStartedAgentsStep port={login} onAgentsConnected={vi.fn()} />);
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Not installed"));
    fireEvent.click(row("Claude Code"));
    fireEvent.click(await screen.findByRole("button", { name: /^Install/ }));
    expect(await screen.findByText("Installing Claude Code…")).toBeInTheDocument();
    expect(screen.getByText("This takes a minute or two. You can keep going; it finishes in the background.")).toBeInTheDocument();
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Installing"));
    expect(login.workflowClient.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "install" }), expect.anything());
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
  });

  it("shows the connected instance when an agent has a disconnected one listed first", async () => {
    const connected = snapshot({ connection: { authMethod: "api_key" } });
    const both = { ...connected, harnesses: [
      { ...snapshot().harnesses[0]!, id: "claude_old" },
      { ...connected.harnesses[0]!, id: "claude_work" },
    ] } as ProviderSettingsSnapshot;
    const onAgentsConnected = vi.fn();
    render(<GetStartedAgentsStep
      port={port({ snapshot: both }, Promise.resolve([{ ...claude, harnessInstanceId: "claude_old" }, { ...claude, harnessInstanceId: "claude_work" }, codex]))}
      onAgentsConnected={onAgentsConnected}
    />);
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Connected"));
    fireEvent.click(row("Claude Code"));
    const card = await screen.findByRole("region", { name: "Claude Code connection" });
    expect(within(card).getByText("API key")).toBeInTheDocument();
    expect(onAgentsConnected).toHaveBeenLastCalledWith(["claude"]);
  });

  it("shows a connected agent with the Settings connection card", async () => {
    const { rerender } = render(<GetStartedAgentsStep port={port({ snapshot: snapshot({ connection: { authMethod: "api_key" } }) })} onAgentsConnected={vi.fn()} />);
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Connected"));
    fireEvent.click(row("Claude Code"));
    const card = await screen.findByRole("region", { name: "Claude Code connection" });
    expect(within(card).getByText("API key")).toBeInTheDocument();
    expect(within(card).getByText("Billed per request by Anthropic")).toBeInTheDocument();
    // Log out, Disconnect and Change account stay in Settings.
    expect(screen.queryByRole("button", { name: "Change account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    rerender(<GetStartedAgentsStep port={port({ snapshot: snapshot({ connection: { authMethod: "subscription" } }) })} onAgentsConnected={vi.fn()} />);
    expect(await screen.findByText("Claude account")).toBeInTheDocument();
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
  });

  it("says how much Matrix AI credit the owner has, only when it is current and above zero", async () => {
    const now = new Date().toISOString();
    const { rerender } = render(<GetStartedAgentsStep port={port({ snapshot: snapshot({ sources: [creditSource(5_000_000, now)] }) })} onAgentsConnected={vi.fn()} />);
    expect(await screen.findByText("You have $5.00 of Matrix AI credit, so Matrix works without signing in.")).toBeInTheDocument();
    for (const source of [creditSource(0, now), creditSource(5_000_000, "2026-01-01T00:00:00.000Z")]) {
      rerender(<GetStartedAgentsStep port={port({ snapshot: snapshot({ sources: [source] }) })} onAgentsConnected={vi.fn()} />);
      expect(screen.queryByText(/of Matrix AI credit/)).not.toBeInTheDocument();
    }
    rerender(<GetStartedAgentsStep port={port({ snapshot: null })} onAgentsConnected={vi.fn()} />);
    expect(screen.queryByText(/of Matrix AI credit/)).not.toBeInTheDocument();
  });

  it("reports which agents are connected once this computer's state is read", async () => {
    const onAgentsConnected = vi.fn();
    const { rerender } = render(<GetStartedAgentsStep port={port({ snapshot: null })} onAgentsConnected={onAgentsConnected} />);
    rerender(<GetStartedAgentsStep port={port({ snapshot: null, failed: true })} onAgentsConnected={onAgentsConnected} />);
    // Unread or unreadable state is unknown, not "nothing connected".
    expect(onAgentsConnected).not.toHaveBeenCalled();
    rerender(<GetStartedAgentsStep port={port()} onAgentsConnected={onAgentsConnected} />);
    expect(onAgentsConnected).toHaveBeenLastCalledWith([]);
    rerender(<GetStartedAgentsStep port={port({ snapshot: snapshot({ connection: { authMethod: "subscription" } }) })} onAgentsConnected={onAgentsConnected} />);
    expect(onAgentsConnected).toHaveBeenLastCalledWith(["claude"]);
  });

  it("disables sign-in on a read-only computer and says why, like Settings", async () => {
    const readOnly = { ...snapshot(), access: { mode: "read_only", reason: "remote_policy" } } as ProviderSettingsSnapshot;
    render(<GetStartedAgentsStep port={port({ snapshot: readOnly })} onAgentsConnected={vi.fn()} />);
    await waitFor(() => expect(row("Claude Code")).toHaveTextContent("Not connected"));
    fireEvent.click(row("Claude Code"));
    expect(await screen.findByRole("region", { name: "Claude Code connection" })).toBeInTheDocument();
    expect(screen.getByText("Your organization controls these settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Claude account/ })).toBeDisabled();
  });

  it("waits for this computer's provider state before offering a sign-in", () => {
    render(<GetStartedAgentsStep port={port({ snapshot: null })} onAgentsConnected={vi.fn()} />);
    expect(row("Claude Code")).toHaveTextContent("Checking installation");
    fireEvent.click(row("Claude Code"));
    expect(screen.getByRole("status")).toHaveTextContent("Checking Claude Code…");
    expect(screen.queryByRole("button", { name: /Claude account/ })).not.toBeInTheDocument();
  });

  it("points to Settings when this computer cannot sign an agent in here", async () => {
    const { rerender } = render(<GetStartedAgentsStep port={port({}, Promise.resolve([claude]))} onAgentsConnected={vi.fn()} />);
    await waitFor(() => expect(row("Codex")).toHaveTextContent("Not connected"));
    fireEvent.click(row("Codex"));
    expect(await screen.findByText("You can log in to Codex later in Settings > Agents & providers.")).toBeInTheDocument();
    rerender(<GetStartedAgentsStep port={port({ snapshot: null, failed: true })} onAgentsConnected={vi.fn()} />);
    expect(await screen.findByText("You can log in to Codex later in Settings > Agents & providers.")).toBeInTheDocument();
    cleanup();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<GetStartedAgentsStep port={port({}, Promise.reject(new Error("offline")))} onAgentsConnected={vi.fn()} />);
    fireEvent.click(row("Claude Code"));
    expect(await screen.findByText("You can log in to Claude Code later in Settings > Agents & providers.")).toBeInTheDocument();
  });
});
