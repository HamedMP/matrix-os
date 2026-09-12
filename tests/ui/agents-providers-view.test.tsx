// @vitest-environment jsdom
import React from "react";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_AGENT_OPTIONS } from "../../shell/src/components/terminal/terminal-agent-options";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderConnectionAttempt,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import {
  AgentsProvidersView,
  type ProviderSettingsMutationIntent,
} from "../../packages/ui/src/agents-providers/AgentsProvidersView";

const now = "2026-08-30T10:00:00.000Z";
const later = "2026-09-30T10:00:00.000Z";

function snapshot(): ProviderSettingsSnapshot {
  const value = {
    contractVersion: 1,
    atomicConnectSupported: true,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 12 },
    revision: 12,
    refreshedAt: now,
    access: { mode: "writable" },
    configurationHarnessKinds: ["hermes", "openclaw", "pi", "opencode"],
    harnessCatalog: [
      { harness: "hermes", displayName: "Hermes", installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null },
      { harness: "openclaw", displayName: "OpenClaw", installState: "missing", available: true, runnable: false, setupAction: "install", safeReason: "not_installed" },
      { harness: "pi", displayName: "Pi", installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null },
      { harness: "opencode", displayName: "OpenCode", installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null },
    ],
    modelProviders: [
      {
        id: "anthropic",
        displayName: "Anthropic",
        models: [
          { id: "anthropic/claude-opus-5", displayName: "Claude Opus 5", enabled: true },
          { id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true },
        ],
      },
      {
        id: "openai",
        displayName: "OpenAI",
        models: [{ id: "openai/gpt-5.6", displayName: "GPT-5.6", enabled: true }],
      },
    ],
    accessSources: [
      {
        id: "matrix_included",
        kind: "matrix_gateway",
        fundingKind: "matrix_included",
        providerId: "anthropic",
        accountId: null,
        displayName: "Matrix AI included credit",
        readiness: {
          state: "ready",
          checkedAt: now,
          staleAfter: later,
          action: "none",
          safeReason: null,
        },
        eligibleModelIds: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
        usage: {
          kind: "managed_credit",
          authority: "matrix_ledger",
          state: "current",
          scope: "owner_entitlement",
          currency: "USD",
          usedMicrousd: 200_000,
          remainingMicrousd: 750_000,
          limitMicrousd: 1_000_000,
          periodStartedAt: now,
          resetsAt: later,
          asOf: now,
          credit: {
            promotionalBalanceMicrousd: 500_000,
            addonBalanceMicrousd: 500_000,
            creditBalanceMicrousd: 1_000_000,
            reservedMicrousd: 250_000,
            remainingBalanceMicrousd: 750_000,
          },
          budget: {
            monthlyBudgetMicrousd: 1_000_000,
            settledThisMonthMicrousd: 200_000,
            reservedThisMonthMicrousd: 50_000,
            remainingBudgetMicrousd: 750_000,
          },
        },
      },
      {
        id: "owner_anthropic_profile",
        kind: "provider_account",
        fundingKind: "owner_subscription",
        providerId: "anthropic",
        accountId: "account_personal",
        displayName: "Personal Anthropic subscription",
        readiness: {
          state: "ready",
          checkedAt: now,
          staleAfter: later,
          action: "none",
          safeReason: null,
        },
        eligibleModelIds: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
        usage: {
          kind: "subscription_allowance",
          authority: "provider_allowance",
          state: "current",
          scope: "account",
          usedBasisPoints: 2_500,
          resetsAt: later,
          asOf: now,
        },
      },
      {
        id: "owner_anthropic_key",
        kind: "provider_account",
        fundingKind: "owner_api_key",
        providerId: "anthropic",
        accountId: "account_work",
        displayName: "Work Anthropic key",
        readiness: {
          state: "auth_required",
          checkedAt: now,
          staleAfter: later,
          action: "enter_api_key",
          safeReason: "auth",
        },
        eligibleModelIds: ["anthropic/claude-sonnet-5"],
        usage: {
          kind: "metered_api",
          authority: "matrix_observed",
          state: "current",
          scope: "account",
          currency: "USD",
          observedUsageMicrousd: 125_000,
          providerBalance: null,
          periodStartedAt: now,
          resetsAt: later,
          asOf: now,
        },
      },
      {
        id: "owner_openai_profile",
        kind: "provider_account",
        fundingKind: "owner_subscription",
        providerId: "openai",
        accountId: "account_openai",
        displayName: "Personal OpenAI subscription",
        readiness: {
          state: "ready",
          checkedAt: now,
          staleAfter: later,
          action: "none",
          safeReason: null,
        },
        eligibleModelIds: ["openai/gpt-5.6"],
        usage: {
          kind: "subscription_allowance",
          authority: "provider_allowance",
          state: "current",
          scope: "account",
          usedBasisPoints: 1_000,
          resetsAt: later,
          asOf: now,
        },
      },
    ],
    accounts: [
      {
        id: "account_personal",
        providerId: "anthropic",
        displayName: "Personal",
        authMethod: "terminal",
        authState: "authenticated",
        lastCheckedAt: now,
        accessSourceId: "owner_anthropic_profile",
        dependencies: { activeChatCount: 2, resumableChatCount: 1, harnessInstanceCount: 1 },
      },
      {
        id: "account_work",
        providerId: "anthropic",
        displayName: "Work",
        authMethod: "api_key",
        authState: "unauthenticated",
        lastCheckedAt: now,
        accessSourceId: "owner_anthropic_key",
        dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      },
      {
        id: "account_openai",
        providerId: "openai",
        displayName: "OpenAI personal",
        authMethod: "oauth",
        authState: "authenticated",
        lastCheckedAt: now,
        accessSourceId: "owner_openai_profile",
        dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      },
    ],
    harnesses: [
      {
        id: "harness_hermes",
        harness: "hermes",
        displayName: "Hermes",
        accentColor: "teal",
        enabled: true,
        version: "1.8.0",
        installState: "installed",
        authState: "authenticated",
        loginMethods: ["terminal", "oauth", "api_key"],
        recommendedLoginMethod: "terminal",
        connectivity: "online",
        accountIds: ["account_personal", "account_work"],
        selectedAccountId: "account_personal",
        accessSourceId: "owner_anthropic_profile",
        route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        activeChatCount: 2,
      },
      {
        id: "harness_claude",
        harness: "claude",
        displayName: "Claude",
        accentColor: "orange",
        enabled: true,
        version: "2.1.251",
        installState: "installed",
        authState: "authenticated",
        loginMethods: ["terminal"],
        recommendedLoginMethod: "terminal",
        connectivity: "online",
        accountIds: ["account_personal"],
        selectedAccountId: null,
        accessSourceId: "matrix_included",
        route: { kind: "fixed", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        activeChatCount: 0,
      },
    ],
    gatewayPolicy: {
      accessSourceId: "matrix_included",
      monthlyBudgetMicrousd: 1_000_000,
      allowedModelIds: ["anthropic/claude-opus-5"],
      topUpEnabled: true,
    },
  } as ProviderSettingsSnapshot;
  Object.assign(value, {
    supportedActions: [
      "add_harness", "update_harness", "set_harness_enabled", "set_route",
      "select_account", "select_access_source", "start_login", "logout_account",
      "remove_account", "reassign_account", "set_gateway_budget", "set_gateway_allowlist",
      "add_credit", "submit_api_key",
    ],
  });
  return value;
}

function setup(overrides: Partial<React.ComponentProps<typeof AgentsProvidersView>> = {}) {
  const onMutate = vi.fn<(intent: ProviderSettingsMutationIntent) => void>();
  const props: React.ComponentProps<typeof AgentsProvidersView> = {
    snapshot: snapshot(),
    selectedHarnessId: "harness_hermes",
    onSelectHarness: vi.fn(),
    onRefresh: vi.fn(),
    onMutate,
    onOpenTerminal: vi.fn(),
    onOpenBrowser: vi.fn(),
    onAddCredit: vi.fn(),
    ...overrides,
  };
  return { ...render(<AgentsProvidersView {...props} />), props, onMutate };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentsProvidersView", () => {
  it.each(["pi", "opencode"] as const)("requires a saved connection before directly enabling %s, but permits disabling", (kind) => {
    const next = snapshot();
    const harness = next.harnesses[0]!;
    Object.assign(harness, { harness: kind, displayName: kind, enabled: false, accessSourceId: null });
    const { onMutate, rerender, props } = setup({ snapshot: next });
    const toggle = screen.getByRole("switch", { name: `Enable ${kind}` });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription("Choose a connection to enable");
    fireEvent.click(toggle);
    expect(onMutate).not.toHaveBeenCalled();
    const enabled = structuredClone(next);
    enabled.harnesses[0]!.enabled = true;
    rerender(<AgentsProvidersView {...props} snapshot={enabled} />);
    fireEvent.click(screen.getByRole("switch", { name: `Enable ${kind}` }));
    expect(onMutate).toHaveBeenCalledWith({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false });
  });

  it("preserves the confirmed login handoff recovery message instead of claiming settings were lost", () => {
    setup({ error: "Sign-in started. Use Continue to open it again." });
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in started. Use Continue to open it again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Changes were not saved");
  });

  it("never displays arbitrary upstream error details", () => {
    setup({ error: "Anthropic failed with /opt/private/customer-key" });
    expect(screen.getByRole("alert")).toHaveTextContent("Changes were not saved. Refresh and try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("/opt/private");
  });
  it("uses the same shipped agent artwork as the Terminal menu", () => {
    const next = snapshot();
    next.harnesses = (["claude", "codex", "opencode", "pi"] as const).map((harness) => ({
      ...next.harnesses[0]!, id: harness, harness, displayName: harness,
    }));
    const { container } = setup({ snapshot: next, selectedHarnessId: "claude" });
    expect(Array.from(container.querySelectorAll(".matrix-ap-rail-item img")).map((image) => image.getAttribute("src"))).toEqual([
      "/agent-logos/claude-code.png", "/agent-logos/codex.png", "/agent-logos/opencode-white.png", "/agent-logos/pi-coding-agent.png",
    ]);
    for (const option of TERMINAL_AGENT_OPTIONS) {
      const image = container.querySelector(`img[src="${option.logoSrc}"]`);
      expect(image).toBeInTheDocument();
      expect(image?.parentElement).toHaveStyle({ background: option.color });
      expect(existsSync(resolve("shell/public", option.logoSrc.slice(1)))).toBe(true);
    }
    expect(readFileSync("desktop/electron.vite.config.ts", "utf8")).toContain('publicDir: resolve(__dirname, "../shell/public")');
  });

  it("starts the recommended login directly without a method selection step", async () => {
    const next = snapshot();
    next.harnesses[1]!.accountIds = [];
    next.harnesses[1]!.authState = "unauthenticated";
    const onMutate = vi.fn().mockResolvedValue(true);
    setup({ snapshot: next, selectedHarnessId: "harness_claude", onMutate });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledWith({
      type: "start_login", harnessInstanceId: "harness_claude", accountId: null, method: "terminal",
    }));
    expect(screen.queryByRole("button", { name: "Recommended · Terminal" })).not.toBeInTheDocument();
  });

  it("offers Matrix AI inside Pi and enables its supported route in one action", async () => {
    const next = snapshot();
    const harness = next.harnesses[0]!;
    Object.assign(harness, { harness: "pi", displayName: "Pi", enabled: false, accountIds: [], selectedAccountId: null, accessSourceId: null });
    const onMutate = vi.fn().mockResolvedValue(false);
    setup({ snapshot: next, onMutate });
    const connection = screen.getByRole("group", { name: "Pi connection" });
    await act(async () => { fireEvent.click(within(connection).getByRole("button", { name: /Use Matrix AI/ })); });
    expect(onMutate).toHaveBeenCalledWith({
      type: "set_route", harnessInstanceId: harness.id,
      route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      accessSourceId: "matrix_included", accountId: null, enableHarness: true,
    });
    expect(screen.getByRole("switch", { name: "Enable Pi" })).not.toBeChecked();
    expect(within(connection).getByRole("button", { name: /Own account/ })).toBeVisible();
  });

  it("keeps Matrix AI upstream providers private in an agent route", () => {
    const next = snapshot();
    const harness = next.harnesses[0]!;
    Object.assign(harness, {
      harness: "opencode",
      displayName: "OpenCode",
      accessSourceId: "matrix_cloudflare",
      selectedAccountId: null,
      route: {
        kind: "configurable",
        providerId: "cloudflare",
        modelId: "@cf/zai-org/glm-5.3-flash",
      },
    });
    next.modelProviders.push({
      id: "cloudflare",
      displayName: "Cloudflare Workers AI",
      models: [{
        id: "@cf/zai-org/glm-5.3-flash",
        displayName: "GLM 5.3 Flash",
        enabled: true,
      }],
    });
    next.accessSources.push({
      ...next.accessSources[0]!,
      id: "matrix_cloudflare",
      kind: "matrix_gateway",
      fundingKind: "matrix_included",
      providerId: "cloudflare",
      accountId: null,
      displayName: "Matrix AI",
      eligibleModelIds: ["@cf/zai-org/glm-5.3-flash"],
    });
    next.gatewayPolicy!.allowedModelIds.push("@cf/zai-org/glm-5.3-flash");

    setup({ snapshot: next });

    expect(screen.queryByLabelText("Model provider")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("@cf/zai-org/glm-5.3-flash");
    expect(screen.getByRole("option", { name: "GLM 5.3 Flash" })).toBeVisible();
    expect(screen.queryByText("Cloudflare Workers AI")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "OpenCode connection" }))
      .toHaveTextContent("Using Matrix AI");
  });

  it("asks for a runtime update before connecting a disabled agent on a legacy gateway", () => {
    const next = snapshot();
    delete next.atomicConnectSupported;
    Object.assign(next.harnesses[0]!, { harness: "pi", displayName: "Pi", enabled: false });
    const onMutate = vi.fn();
    setup({ snapshot: next, onMutate });
    const connection = screen.getByRole("group", { name: "Pi connection" });
    expect(within(connection).getByRole("button", { name: /Use Matrix AI/ })).toBeDisabled();
    expect(within(connection).getByText(/Update this computer/)).toBeVisible();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("keeps Matrix route selection compatible with an already-enabled legacy agent", async () => {
    const next = snapshot();
    delete next.atomicConnectSupported;
    Object.assign(next.harnesses[0]!, { harness: "pi", displayName: "Pi", enabled: true });
    const onMutate = vi.fn().mockResolvedValue(true);
    setup({ snapshot: next, onMutate });
    await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Pi connection" })).getByRole("button", { name: /Use Matrix AI/ })); });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ type: "set_route" }));
    expect(onMutate.mock.calls[0]![0]).not.toHaveProperty("enableHarness");
  });

  it("connects and enables a disabled OpenCode agent through its ready own profile", async () => {
    const next = snapshot();
    const harness = next.harnesses[0]!;
    Object.assign(harness, { harness: "opencode", displayName: "OpenCode", enabled: false, accountIds: [], selectedAccountId: null, accessSourceId: null });
    next.accessSources = [{ ...next.accessSources[0]!, id: "native_opencode", kind: "harness_profile", fundingKind: "owner_account", harness: "opencode", displayName: "OpenCode profile" }];
    const onMutate = vi.fn().mockResolvedValue(true);
    setup({ snapshot: next, onMutate });
    fireEvent.click(within(screen.getByRole("group", { name: "OpenCode connection" })).getByRole("button", { name: /Own account/ }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledWith({
      type: "set_route", harnessInstanceId: harness.id,
      route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      accessSourceId: "native_opencode", accountId: null, enableHarness: true,
    }));
  });

  it("does not describe a disabled saved Matrix route as in use", async () => {
    const next = snapshot();
    Object.assign(next.harnesses[0]!, { harness: "pi", displayName: "Pi", enabled: false, accessSourceId: "matrix_included" });
    const { onMutate } = setup({ snapshot: next });
    const connection = screen.getByRole("group", { name: "Pi connection" });
    expect(within(connection).queryByRole("button", { name: /Using Matrix AI/ })).not.toBeInTheDocument();
    const useMatrix = within(connection).getByRole("button", { name: /Use Matrix AI/ });
    expect(useMatrix).toHaveAttribute("aria-pressed", "false");
    await act(async () => { fireEvent.click(useMatrix); });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ type: "set_route", enableHarness: true }));
  });

  it("keeps unavailable Matrix AI visible but never makes a blocked OpenCode route selectable", () => {
    const next = snapshot();
    Object.assign(next.harnesses[0]!, { harness: "opencode", displayName: "OpenCode", enabled: false, accessSourceId: null });
    next.gatewayPolicy!.allowedModelIds = [];
    const { onMutate } = setup({ snapshot: next });
    const connection = screen.getByRole("group", { name: "OpenCode connection" });
    expect(within(connection).getByRole("button", { name: /Use Matrix AI/ })).toBeDisabled();
    fireEvent.click(within(connection).getByRole("button", { name: /Use Matrix AI/ }));
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("keeps saved account logout reachable without leaving Matrix AI", async () => {
    const next = snapshot();
    Object.assign(next.harnesses[0]!, { harness: "pi", displayName: "Pi", accountIds: ["account_work"], selectedAccountId: null, accessSourceId: "matrix_included" });
    next.accounts.find((account) => account.id === "account_work")!.authState = "authenticated";
    const onMutate = vi.fn().mockResolvedValue(true);
    setup({ snapshot: next, onMutate });
    fireEvent.click(screen.getByText("Manage saved accounts"));
    fireEvent.click(screen.getByRole("button", { name: "Log out Work" }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledWith({ type: "logout_account", accountId: "account_work" }));
    expect(onMutate).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_route" }));
  });

  it("contains failed managed connection errors without changing the selected route", async () => {
    const next = snapshot();
    Object.assign(next.harnesses[0]!, { harness: "pi", displayName: "Pi", enabled: false, accessSourceId: null });
    setup({ snapshot: next, onMutate: vi.fn().mockRejectedValue(new Error("private provider details")) });
    fireEvent.click(within(screen.getByRole("group", { name: "Pi connection" })).getByRole("button", { name: /Use Matrix AI/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be updated"));
    expect(screen.getByRole("switch", { name: "Enable Pi" })).not.toBeChecked();
    expect(screen.queryByText("private provider details")).not.toBeInTheDocument();
  });

  it("derives the last checked label from the snapshot refresh time", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-30T10:02:00.000Z");
    setup();

    expect(screen.getByText("Checked 2 minutes ago")).toBeVisible();
  });

  it("renders the T3-derived expandable agent list with add at the top", () => {
    setup();

    const rail = screen.getByRole("region", { name: "Installed agents" });
    expect(screen.getByRole("button", { name: "Add agent" })).toBeVisible();
    expect(within(rail).getByRole("button", { name: /Hermes.*Ready/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Hermes configuration" })).toBeVisible();
    expect(screen.getByLabelText("Model provider")).toHaveValue("anthropic");
    expect(screen.getByLabelText("Model")).toHaveValue("anthropic/claude-opus-5");
    expect(screen.getByTestId("provider-signal-path")).toHaveTextContent("Personal Anthropic subscription");
    expect(screen.getByRole("heading", { name: "Choose the model" })).toBeVisible();
    fireEvent.click(screen.getByText("Advanced settings"));
    expect(screen.getByRole("heading", { name: "Access" })).toBeVisible();
    expect(screen.getByLabelText("Paid through")).toHaveValue("owner_anthropic_profile");
    expect(screen.getByTestId("provider-signal-path")).toHaveTextContent("Paid through");
    expect(screen.getByText(/Connect your own provider account in Terminal/)).toBeVisible();
  });

  it("switches a generic harness to another provider as one coherent route intent", () => {
    const { onMutate } = setup();

    expect(within(screen.getByLabelText("Model provider")).getByRole("option", { name: "OpenAI" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Model provider"), { target: { value: "openai" } });
    fireEvent.click(screen.getByRole("switch", { name: "Enable Hermes" }));

    expect(onMutate).toHaveBeenCalledWith({
      type: "set_route",
      harnessInstanceId: "harness_hermes",
      route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
      accessSourceId: "owner_openai_profile",
      accountId: "account_openai",
    });
    expect(onMutate).toHaveBeenCalledWith({ type: "set_harness_enabled", harnessInstanceId: "harness_hermes", enabled: false });
  });

  it("emits compatible access-source and account intents and never sends a blank account", () => {
    const next = snapshot();
    const harness = next.harnesses[0]!;
    harness.harness = "pi";
    harness.displayName = "Pi";
    harness.accountIds = ["account_work"];
    harness.route = { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5" };
    harness.accessSourceId = "matrix_included";
    harness.selectedAccountId = null;
    next.gatewayPolicy!.allowedModelIds = ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"];
    const { onMutate } = setup({ snapshot: next });

    fireEvent.change(screen.getByLabelText("Paid through"), { target: { value: "owner_anthropic_key" } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "account_work" } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "" } });

    expect(onMutate).toHaveBeenCalledWith({ type: "select_access_source", harnessInstanceId: "harness_hermes", accessSourceId: "owner_anthropic_key" });
    expect(onMutate).toHaveBeenCalledWith({ type: "select_account", harnessInstanceId: "harness_hermes", accountId: "account_work" });
    expect(onMutate).toHaveBeenCalledWith({ type: "select_access_source", harnessInstanceId: "harness_hermes", accessSourceId: "matrix_included" });
    expect(onMutate).not.toHaveBeenCalledWith(expect.objectContaining({ type: "select_account", accountId: "" }));
  });

  it("keeps fixed harness routes visible but immutable", () => {
    setup({ selectedHarnessId: "harness_claude" });

    expect(screen.getByText("Fixed by Claude")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Model provider" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    const configuration = screen.getByRole("region", { name: "Claude configuration" });
    expect(within(configuration).queryByText("Anthropic")).not.toBeInTheDocument();
    expect(within(configuration).getAllByText("Claude Opus 5").length).toBeGreaterThan(0);
  });

  it("does not advertise generic configuration mutations for specialized harnesses", () => {
    const { onMutate } = setup({ selectedHarnessId: "harness_claude" });

    expect(screen.queryByRole("switch", { name: "Enable Claude" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toBeDisabled();
    fireEvent.click(within(screen.getByTestId("account-account_personal"))
      .getByRole("button", { name: "Log out Personal" }));
    expect(onMutate).toHaveBeenCalledWith({ type: "logout_account", accountId: "account_personal" });

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    expect(within(dialog).queryByRole("radio", { name: "Codex" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Claude" })).toBeNull();
  });

  it("always shows all generic harnesses and explains why unavailable kinds cannot be added", () => {
    const limited = snapshot();
    limited.configurationHarnessKinds = ["hermes", "openclaw"];
    limited.harnessCatalog = limited.harnessCatalog.map((entry) => {
      if (entry.harness === "pi" || entry.harness === "opencode") {
        return { ...entry, available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" };
      }
      return entry;
    });
    setup({ snapshot: limited });

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    expect(within(dialog).getByRole("radio", { name: "Hermes" })).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: "Pi" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "OpenCode" })).toBeDisabled();
    expect(within(dialog).getAllByText(/Unavailable on this computer/)).toHaveLength(2);
    expect(within(dialog).getByRole("radio", { name: "Pi" }))
      .toHaveAccessibleDescription(/Unavailable on this computer/);
    expect(within(dialog).getByRole("radio", { name: "OpenCode" }))
      .toHaveAccessibleDescription(/Unavailable on this computer/);
  });

  it("shows the truthful setup path for a supported harness that is not installed", () => {
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenClaw" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(dialog).getByText("Install OpenClaw")).toBeVisible();
    expect(within(dialog).getByText(/Installation runs in a visible Terminal/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("marks access sources that still need authentication and keeps the auth handoff visible", () => {
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    const sources = within(dialog).getByLabelText("Use AI through");

    expect(within(sources).getByRole("option", {
      name: "Work Anthropic key · setup required",
    })).toBeVisible();
    fireEvent.change(sources, { target: { value: "owner_anthropic_key" } });
    expect(within(dialog).getByText(/Only connections reported ready can continue/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("shows exact, stale, and unavailable gateway credit without inventing balances", () => {
    const current = snapshot();
    const { rerender } = setup({ snapshot: current });
    expect(screen.getByText("$0.75 remaining")).toBeVisible();
    expect(screen.getByText("$0.20 used of $1.00")).toBeVisible();

    const stale = structuredClone(current);
    stale.accessSources[0]!.usage = { ...stale.accessSources[0]!.usage, state: "stale" } as typeof stale.accessSources[0]["usage"];
    rerender(<AgentsProvidersView {...setupProps(stale)} />);
    expect(screen.getByText(/Credit last confirmed/)).toBeVisible();

    const unavailable = structuredClone(current);
    unavailable.accessSources[0]!.usage = {
      kind: "unavailable",
      authority: "unavailable",
      state: "unavailable",
      scope: "owner_entitlement",
      reason: "ledger_not_available",
      asOf: null,
    };
    rerender(<AgentsProvidersView {...setupProps(unavailable)} />);
    expect(screen.getByText("Credit unavailable")).toBeVisible();
    expect(screen.queryByText("$0.00 remaining")).toBeNull();
  });

  it("shows per-account usage and keeps login, logout, and remove distinct", async () => {
    const { onMutate } = setup();
    const personal = screen.getByTestId("account-account_personal");
    const work = screen.getByTestId("account-account_work");

    expect(within(personal).getByText("25% used")).toBeVisible();
    expect(within(work).getByText("$0.13 observed")).toBeVisible();
    fireEvent.click(within(personal).getByRole("button", { name: "Log out Personal" }));
    await waitFor(() => expect(within(work).getByRole("button", { name: "Log in Work" })).toBeEnabled());
    fireEvent.click(within(work).getByRole("button", { name: "Log in Work" }));
    await waitFor(() => expect(within(work).getByRole("button", { name: "Remove Work" })).toBeEnabled());
    fireEvent.click(within(work).getByRole("button", { name: "Remove Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove account" }));

    expect(onMutate).toHaveBeenCalledWith({ type: "logout_account", accountId: "account_personal" });
    expect(onMutate).toHaveBeenCalledWith({ type: "start_login", harnessInstanceId: "harness_hermes", accountId: "account_work", method: "api_key" });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "remove_account",
      accountId: "account_work",
      confirmation: "remove_account",
    }));
  });

  it("requires dependency reassignment before removing an account in use", () => {
    const value = snapshot();
    value.harnesses[0]!.harness = "pi";
    const { onMutate } = setup({ snapshot: value });
    const personal = screen.getByTestId("account-account_personal");
    fireEvent.click(within(personal).getByRole("button", { name: "Remove Personal" }));

    const dialog = screen.getByRole("dialog", { name: "Remove Personal" });
    expect(dialog).toHaveTextContent("2 active chats");
    expect(dialog).toHaveTextContent("1 resumable chat");
    expect(within(dialog).queryByRole("button", { name: "Remove account" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Reassign to"), { target: { value: "source:matrix_included" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reassign dependencies" }));

    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "reassign_account",
      fromAccountId: "account_personal",
      target: { kind: "access_source", accessSourceId: "matrix_included" },
      scope: "all_dependencies",
    }));
  });

  it("offers only reassignment targets that serve every dependent harness route", () => {
    const value = snapshot();
    value.harnesses[0]!.harness = "pi";
    setup({ snapshot: value });
    fireEvent.click(within(screen.getByTestId("account-account_personal"))
      .getByRole("button", { name: "Remove Personal" }));

    const choices = within(screen.getByRole("dialog", { name: "Remove Personal" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(choices).toContain("Matrix AI included credit");
    expect(choices).not.toContain("Work");
    expect(choices).not.toContain("Work Anthropic key");
  });

  it("opens only opaque terminal session ids and owner-gateway authorization paths", () => {
    const terminalAttempt: ProviderConnectionAttempt = {
      id: "attempt_terminal",
      harnessInstanceId: "harness_hermes",
      accountId: null,
      method: "terminal",
      state: "pending",
      action: { kind: "open_terminal", terminalSessionId: "provider-login-123" },
      expiresAt: later,
      safeFailure: null,
    };
    const onOpenTerminal = vi.fn();
    const onOpenBrowser = vi.fn();
    const { rerender } = setup({ connectionAttempt: terminalAttempt, onOpenTerminal, onOpenBrowser });
    fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("provider-login-123");

    const browserAttempt: ProviderConnectionAttempt = {
      ...terminalAttempt,
      id: "attempt_browser",
      method: "oauth",
      action: { kind: "open_browser", authorizationPath: "/api/ai/providers/login-attempts/attempt_browser/authorize" },
    };
    rerender(<AgentsProvidersView {...setupProps(snapshot(), { connectionAttempt: browserAttempt, onOpenTerminal, onOpenBrowser })} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));
    expect(onOpenBrowser).toHaveBeenCalledWith("/api/ai/providers/login-attempts/attempt_browser/authorize");
  });

  it("controls gateway budget and offers one shared, server-backed add-on package flow", async () => {
    const onRefresh = vi.fn();
    let finishCheckout!: () => void;
    const onAddCredit = vi.fn(() => new Promise<void>((resolve) => { finishCheckout = resolve; }));
    const { onMutate } = setup({ onRefresh, onAddCredit });

    fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" }));
    fireEvent.click(screen.getByRole("button", { name: "Add credit" }));
    expect(screen.getByRole("dialog", { name: "Add Matrix AI credit" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "$5 credit" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "$10 credit" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));
    expect(screen.getByRole("button", { name: "Opening checkout…" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Monthly budget in USD"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow Claude Sonnet 5" }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onAddCredit).toHaveBeenCalledWith(
      "matrix_included",
      "usd_10",
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    );
    expect(onMutate).toHaveBeenCalledWith({ type: "set_gateway_budget", monthlyBudgetMicrousd: 2_500_000 });
    expect(onMutate).toHaveBeenCalledWith({
      type: "set_gateway_allowlist",
      allowedModelIds: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
    });
    finishCheckout();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Matrix AI credit" })).toBeNull());
  });

  it("keeps checkout failures safe and retryable inside the shared dialog", async () => {
    const onAddCredit = vi.fn().mockRejectedValue(new Error("postgresql://secret@db.internal"));
    setup({ onAddCredit });
    fireEvent.click(screen.getByRole("button", { name: "Add credit" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Checkout could not be opened. Try again.");
    expect(screen.queryByText(/postgresql|secret|internal/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
    const firstRequestId = onAddCredit.mock.calls[0]?.[2];
    fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));
    await waitFor(() => expect(onAddCredit).toHaveBeenCalledTimes(2));
    expect(onAddCredit.mock.calls[1]?.[2]).toBe(firstRequestId);
  });

  it("shows install, offline, busy, and read-only states without inventing an install capability", () => {
    const base = snapshot();
    base.harnesses.push({
      ...base.harnesses[0]!,
      id: "harness_pi",
      harness: "pi",
      displayName: "Pi",
      enabled: false,
      version: null,
      installState: "missing",
      connectivity: "offline",
      accountIds: [],
      selectedAccountId: null,
      accessSourceId: "matrix_included",
      activeChatCount: 0,
    });
    const { rerender } = setup({ snapshot: base, selectedHarnessId: "harness_pi" });
    expect(screen.getByText("Connection not verified")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install Pi" })).not.toBeInTheDocument();
    expect(screen.getByText(/Install from this computer’s Terminal/)).toBeVisible();

    const readOnly = structuredClone(base);
    readOnly.access = { mode: "read_only", reason: "remote_policy" };
    Object.assign(readOnly, { supportedActions: [] });
    rerender(<AgentsProvidersView {...setupProps(readOnly, { selectedHarnessId: "harness_pi", busy: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Read only");
    expect(screen.queryByRole("button", { name: "Install Pi" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add agent" })).not.toBeInTheDocument();
  });

  it("shows a failed saved route even when it is absent from the selectable catalog", () => {
    const base = snapshot();
    Object.assign(base.harnesses[0]!, {
      connectivity: "offline",
      authState: "failed",
      accessSourceId: null,
      selectedAccountId: null,
      routeAvailability: "catalog_unavailable",
      route: {
        kind: "configurable",
        providerId: "baseten",
        modelId: "baseten:zai-org/GLM-5.3",
      },
    });

    setup({ snapshot: base });

    expect(within(screen.getByLabelText("Model provider"))
      .getByRole("option", { name: "Baseten · Unavailable" })).toBeVisible();
    expect(within(screen.getByLabelText("Model"))
      .getByRole("option", { name: "GLM 5.3 · Unavailable" })).toBeVisible();
    expect(screen.getByText("Saved model catalog unavailable")).toBeVisible();
  });

  it("hides unsupported future account and credit actions without inventing capabilities", () => {
    const limited = snapshot();
    Object.assign(limited, {
      supportedActions: [
        "add_harness", "update_harness", "set_harness_enabled", "set_route",
        "select_account", "select_access_source", "set_gateway_budget", "set_gateway_allowlist",
      ],
    });
    setup({ snapshot: limited });

    expect(screen.queryByRole("button", { name: "+ Add account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out Personal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Personal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add credit" })).not.toBeInTheDocument();
  });

  it("renders platform-authoritative gateway policy as read-only", () => {
    const authoritative = snapshot();
    authoritative.supportedActions = authoritative.supportedActions.filter((action) =>
      action !== "set_gateway_budget" && action !== "set_gateway_allowlist");
    const { onMutate } = setup({ snapshot: authoritative });

    expect(screen.queryByLabelText("Monthly budget in USD")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save budget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Allow Claude Sonnet 5" })).not.toBeInTheDocument();
    const gateway = screen.getByRole("region", { name: "Matrix AI" });
    fireEvent.click(within(gateway).getByText("Usage & available models"));
    expect(within(gateway).getByText("Managed by your workspace")).toBeVisible();
    expect(within(gateway).getByText("$1.00")).toBeVisible();
    expect(within(gateway).getByText("Claude Opus 5")).toBeVisible();
    expect(within(gateway).queryByText("Claude Sonnet 5")).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("adds a harness from the top-rail flow without collecting credentials", () => {
    const { onMutate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add agent" }));

    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "add_harness",
      harness: "opencode",
      displayName: "OpenCode",
      accountId: null,
    }));
    expect(within(dialog).queryByLabelText(/API key/i)).toBeNull();
  });

  it("offers direct adapters only routes backed by portable credentials", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(within(dialog).getByLabelText("Use AI through"))
      .getByRole("option", { name: "Matrix AI included credit" })).toBeVisible();
    expect(within(within(dialog).getByLabelText("Use AI through"))
      .queryByRole("option", { name: "Personal Anthropic subscription" })).toBeNull();
    expect(within(within(dialog).getByLabelText("Use AI through"))
      .getByRole("option", { name: "Work Anthropic key · setup required" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(dialog).queryByLabelText("Model provider")).toBeNull();
  });

  it("offers a harness-owned OpenCode catalog as real provider and model choices", () => {
    const native = snapshot();
    Object.assign(native.harnesses[0]!, {
      harness: "opencode",
      displayName: "OpenCode",
      route: { kind: "configurable", providerId: "baseten", modelId: "baseten:deepseek-ai/DeepSeek-V4-Pro" },
      accessSourceId: "harness_opencode_baseten",
      selectedAccountId: null,
    });
    native.modelProviders.push({
      id: "baseten",
      displayName: "Baseten",
      models: [
        { id: "baseten:deepseek-ai/DeepSeek-V4-Pro", displayName: "DeepSeek V4 Pro", enabled: true },
        { id: "baseten:zai-org/GLM-5.3", displayName: "GLM-5.3", enabled: true },
      ],
    });
    native.accessSources.push({
      id: "harness_opencode_baseten",
      kind: "harness_profile",
      harness: "opencode",
      fundingKind: "owner_account",
      providerId: "baseten",
      accountId: null,
      displayName: "OpenCode account",
      readiness: {
        state: "ready",
        checkedAt: now,
        staleAfter: later,
        action: "none",
        safeReason: null,
      },
      eligibleModelIds: [
        "baseten:deepseek-ai/DeepSeek-V4-Pro",
        "baseten:zai-org/GLM-5.3",
      ],
      usage: {
        kind: "unavailable",
        authority: "unavailable",
        state: "not_applicable",
        scope: "access_source",
        reason: "provider_does_not_report",
        asOf: now,
      },
    });
    const { onMutate } = setup({ snapshot: native });
    expect(within(screen.getByLabelText("Model provider"))
      .getByRole("option", { name: "Baseten" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Model provider"), { target: { value: "baseten" } });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "set_route",
      harnessInstanceId: "harness_hermes",
      route: { kind: "configurable", providerId: "baseten", modelId: "baseten:deepseek-ai/DeepSeek-V4-Pro" },
      accessSourceId: "harness_opencode_baseten",
      accountId: null,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.change(within(dialog).getByLabelText("Use AI through"), { target: { value: "harness_opencode_baseten" } });
    expect(within(within(dialog).getByLabelText("Use AI through"))
      .getByRole("option", { name: "OpenCode account" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(within(dialog).getByLabelText("Model provider"))
      .getByRole("option", { name: "Baseten" })).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText("Model provider"), {
      target: { value: "baseten" },
    });
    expect(within(within(dialog).getByLabelText("Model"))
      .getByRole("option", { name: "DeepSeek V4 Pro" })).toBeVisible();
  });

  it("keeps a failed live route visible while its access source is unavailable", () => {
    const unavailable = snapshot();
    Object.assign(unavailable.harnesses[0]!, {
      harness: "opencode",
      displayName: "OpenCode",
      connectivity: "offline",
      authState: "unknown",
      route: {
        kind: "configurable",
        providerId: "baseten",
        modelId: "baseten:zai-org/GLM-5.3",
      },
      accessSourceId: null,
      selectedAccountId: null,
    });
    unavailable.modelProviders.push({
      id: "baseten",
      displayName: "Baseten",
      models: [{ id: "baseten:zai-org/GLM-5.3", displayName: "GLM-5.3", enabled: true }],
    });

    setup({ snapshot: unavailable });

    expect(screen.getByLabelText("Model provider")).toHaveValue("baseten");
    expect(within(screen.getByLabelText("Model provider"))
      .getByRole("option", { name: "Baseten" })).toBeVisible();
    expect(screen.getByLabelText("Model")).toHaveValue("baseten:zai-org/GLM-5.3");
    expect(screen.getByTestId("provider-signal-path")).toHaveTextContent("Not selected");
  });

  it("adds a second instance of an existing harness with its own route and account", () => {
    const { onMutate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Hermes" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.change(within(dialog).getByLabelText("Use AI through"), { target: { value: "owner_openai_profile" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.change(within(dialog).getByLabelText("Model provider"), {
      target: { value: "openai" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add agent" }));

    expect(onMutate).toHaveBeenCalledWith({
      type: "add_harness",
      harness: "hermes",
      displayName: "Hermes",
      route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
      accessSourceId: "owner_openai_profile",
      accountId: "account_openai",
    });
  });

  it("does not offer a model outside the selected Matrix gateway allowlist", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(dialog).getByLabelText("Use AI through")).toHaveValue("matrix_included");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(within(dialog).getByLabelText("Model"))
      .queryByRole("option", { name: "Claude Sonnet 5" })).toBeNull();
  });
});

function setupProps(
  nextSnapshot: ProviderSettingsSnapshot,
  overrides: Partial<React.ComponentProps<typeof AgentsProvidersView>> = {},
): React.ComponentProps<typeof AgentsProvidersView> {
  return {
    snapshot: nextSnapshot,
    selectedHarnessId: "harness_hermes",
    onSelectHarness: vi.fn(),
    onRefresh: vi.fn(),
    onMutate: vi.fn(),
    onOpenTerminal: vi.fn(),
    onOpenBrowser: vi.fn(),
    onAddCredit: vi.fn(),
    ...overrides,
  };
}
