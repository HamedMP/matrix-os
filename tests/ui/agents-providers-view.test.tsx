// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 12 },
    revision: 12,
    refreshedAt: now,
    access: { mode: "writable" },
    configurationHarnessKinds: ["hermes", "openclaw", "pi", "opencode"],
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
        id: "source_matrix",
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
        id: "source_personal",
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
        id: "source_work",
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
        id: "source_openai",
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
        accessSourceId: "source_personal",
        dependencies: { activeChatCount: 2, resumableChatCount: 1, harnessInstanceCount: 1 },
      },
      {
        id: "account_work",
        providerId: "anthropic",
        displayName: "Work",
        authMethod: "api_key",
        authState: "unauthenticated",
        lastCheckedAt: now,
        accessSourceId: "source_work",
        dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      },
      {
        id: "account_openai",
        providerId: "openai",
        displayName: "OpenAI personal",
        authMethod: "oauth",
        authState: "authenticated",
        lastCheckedAt: now,
        accessSourceId: "source_openai",
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
        accessSourceId: "source_personal",
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
        accessSourceId: "source_matrix",
        route: { kind: "fixed", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        activeChatCount: 0,
      },
    ],
    gatewayPolicy: {
      accessSourceId: "source_matrix",
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
  it("derives the last checked label from the snapshot refresh time", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-30T10:02:00.000Z");
    setup();

    expect(screen.getByText("Checked 2 minutes ago")).toBeVisible();
  });

  it("renders the T3-derived harness rail with add at the top and a selected editor", () => {
    setup();

    const rail = screen.getByRole("navigation", { name: "Agent harnesses" });
    const controls = within(rail).getAllByRole("button");
    expect(controls[0]).toHaveAccessibleName("Add harness");
    expect(within(rail).getByRole("button", { name: /Hermes/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { name: "Hermes" })).toBeVisible();
    expect(screen.getByLabelText("Model provider")).toHaveValue("anthropic");
    expect(screen.getByLabelText("Model")).toHaveValue("anthropic/claude-opus-5");
    expect(screen.getByTestId("provider-signal-path")).toHaveTextContent("Personal Anthropic subscription");
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
      accessSourceId: "source_openai",
      accountId: "account_openai",
    });
    expect(onMutate).toHaveBeenCalledWith({ type: "set_harness_enabled", harnessInstanceId: "harness_hermes", enabled: false });
  });

  it("emits compatible access-source and account intents and never sends a blank account", () => {
    const next = snapshot();
    const harness = next.harnesses[0]!;
    harness.route = { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5" };
    harness.accessSourceId = "source_matrix";
    harness.selectedAccountId = null;
    next.gatewayPolicy!.allowedModelIds = ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"];
    const { onMutate } = setup({ snapshot: next });

    fireEvent.change(screen.getByLabelText("Access source"), { target: { value: "source_personal" } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "account_work" } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "" } });

    expect(onMutate).toHaveBeenCalledWith({ type: "select_access_source", harnessInstanceId: "harness_hermes", accessSourceId: "source_personal" });
    expect(onMutate).toHaveBeenCalledWith({ type: "select_account", harnessInstanceId: "harness_hermes", accountId: "account_work" });
    expect(onMutate).toHaveBeenCalledWith({ type: "select_access_source", harnessInstanceId: "harness_hermes", accessSourceId: "source_matrix" });
    expect(onMutate).not.toHaveBeenCalledWith(expect.objectContaining({ type: "select_account", accountId: "" }));
  });

  it("keeps fixed harness routes visible but immutable", () => {
    setup({ selectedHarnessId: "harness_claude" });

    expect(screen.getByText("Fixed by Claude")).toBeVisible();
    expect(screen.getByLabelText("Model provider")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
  });

  it("does not advertise generic configuration mutations for specialized harnesses", () => {
    const { onMutate } = setup({ selectedHarnessId: "harness_claude" });

    expect(screen.getByRole("switch", { name: "Enable Claude" })).toBeDisabled();
    expect(screen.getByLabelText("Display name")).toBeDisabled();
    fireEvent.click(within(screen.getByTestId("account-account_personal"))
      .getByRole("button", { name: "Log out Personal" }));
    expect(onMutate).toHaveBeenCalledWith({ type: "logout_account", accountId: "account_personal" });

    fireEvent.click(screen.getByRole("button", { name: "Add harness" }));
    const dialog = screen.getByRole("dialog", { name: "Add harness" });
    expect(within(dialog).queryByRole("radio", { name: "Codex" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Claude" })).toBeNull();
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

  it("shows per-account usage and keeps login, logout, and remove distinct", () => {
    const { onMutate } = setup();
    const personal = screen.getByTestId("account-account_personal");
    const work = screen.getByTestId("account-account_work");

    expect(within(personal).getByText("25% used")).toBeVisible();
    expect(within(work).getByText("$0.13 observed")).toBeVisible();
    fireEvent.click(within(personal).getByRole("button", { name: "Log out Personal" }));
    fireEvent.click(within(work).getByRole("button", { name: "Log in Work" }));
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
    const { onMutate } = setup();
    const personal = screen.getByTestId("account-account_personal");
    fireEvent.click(within(personal).getByRole("button", { name: "Remove Personal" }));

    const dialog = screen.getByRole("dialog", { name: "Remove Personal" });
    expect(dialog).toHaveTextContent("2 active chats");
    expect(dialog).toHaveTextContent("1 resumable chat");
    expect(within(dialog).queryByRole("button", { name: "Remove account" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Reassign to"), { target: { value: "source:source_matrix" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reassign dependencies" }));

    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "reassign_account",
      fromAccountId: "account_personal",
      target: { kind: "access_source", accessSourceId: "source_matrix" },
      scope: "all_dependencies",
    }));
  });

  it("offers only reassignment targets that serve every dependent harness route", () => {
    setup();
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
      "source_matrix",
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
      accessSourceId: "source_matrix",
      activeChatCount: 0,
    });
    const { rerender } = setup({ snapshot: base, selectedHarnessId: "harness_pi" });
    expect(screen.getAllByText("Offline")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Install Pi" })).toBeDisabled();

    const readOnly = structuredClone(base);
    readOnly.access = { mode: "read_only", reason: "remote_policy" };
    Object.assign(readOnly, { supportedActions: [] });
    rerender(<AgentsProvidersView {...setupProps(readOnly, { selectedHarnessId: "harness_pi", busy: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Read only");
    expect(screen.getByRole("button", { name: "Install Pi" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add harness" })).toBeDisabled();
  });

  it("keeps unsupported future account and credit actions visible but explanatory and disabled", () => {
    const limited = snapshot();
    Object.assign(limited, {
      supportedActions: [
        "add_harness", "update_harness", "set_harness_enabled", "set_route",
        "select_account", "select_access_source", "set_gateway_budget", "set_gateway_allowlist",
      ],
    });
    setup({ snapshot: limited });

    expect(screen.getByRole("button", { name: "+ Add account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Log out Personal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Personal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add credit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add credit" })).toHaveAttribute("title", "Adding credit is not available yet");
  });

  it("renders platform-authoritative gateway policy as read-only", () => {
    const authoritative = snapshot();
    authoritative.supportedActions = authoritative.supportedActions.filter((action) =>
      action !== "set_gateway_budget" && action !== "set_gateway_allowlist");
    const { onMutate } = setup({ snapshot: authoritative });

    expect(screen.getByLabelText("Monthly budget in USD")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save budget" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Allow Claude Sonnet 5" })).toBeDisabled();
    expect(screen.getByText("Some gateway controls are unavailable in this runtime.")).toBeVisible();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("adds a harness from the top-rail flow without collecting credentials", () => {
    const { onMutate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add harness" }));
    const dialog = screen.getByRole("dialog", { name: "Add harness" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "OpenCode Work" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add harness" }));

    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "add_harness",
      harness: "opencode",
      displayName: "OpenCode Work",
      accountId: null,
    }));
    expect(within(dialog).queryByLabelText(/API key/i)).toBeNull();
  });

  it("adds a second instance of an existing harness with its own route and account", () => {
    const { onMutate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add harness" }));
    const dialog = screen.getByRole("dialog", { name: "Add harness" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Hermes" }));
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Hermes OpenAI" },
    });
    fireEvent.change(within(dialog).getByLabelText("Model provider"), {
      target: { value: "openai" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add harness" }));

    expect(onMutate).toHaveBeenCalledWith({
      type: "add_harness",
      harness: "hermes",
      displayName: "Hermes OpenAI",
      route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
      accessSourceId: "source_openai",
      accountId: "account_openai",
    });
  });

  it("does not offer a Matrix gateway source for a model outside its allowlist", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Add harness" }));
    const dialog = screen.getByRole("dialog", { name: "Add harness" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.change(within(dialog).getByLabelText("Model"), {
      target: { value: "anthropic/claude-sonnet-5" },
    });

    expect(within(within(dialog).getByLabelText("Access source"))
      .queryByRole("option", { name: "Matrix AI included credit" })).toBeNull();
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
