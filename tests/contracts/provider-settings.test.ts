import { describe, expect, it } from "vitest";
import {
  ProviderAccountSchema,
  ProviderConnectionAttemptActionSchema,
  ProviderConnectionAttemptSchema,
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  ProviderSettingsSupportedActionSchema,
  ProviderUsageSchema,
  type ProviderSettingsMutation,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";

const now = "2026-08-30T10:00:00.000Z";
const later = "2026-09-30T10:00:00.000Z";

function readiness(state: "ready" | "stale" = "ready") {
  return {
    state,
    checkedAt: now,
    staleAfter: later,
    action: state === "ready" ? "none" as const : "retry" as const,
    safeReason: state === "ready" ? null : "timeout" as const,
  };
}

function makeSnapshot(): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 12 },
    revision: 12,
    refreshedAt: now,
    access: { mode: "writable" },
    supportedActions: [
      "add_harness",
      "remove_harness",
      "update_harness",
      "set_harness_enabled",
      "set_route",
      "select_account",
      "select_access_source",
      "set_gateway_budget",
      "set_gateway_allowlist",
    ],
    modelProviders: [{
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "anthropic/claude-opus-5", displayName: "Claude Opus 5", enabled: true }],
    }],
    accessSources: [
      {
        id: "source_matrix",
        kind: "matrix_gateway",
        fundingKind: "matrix_included",
        providerId: "anthropic",
        accountId: null,
        displayName: "Matrix AI included credit",
        readiness: readiness(),
        eligibleModelIds: ["anthropic/claude-opus-5"],
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
        readiness: readiness(),
        eligibleModelIds: ["anthropic/claude-opus-5"],
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
    ],
    accounts: [{
      id: "account_personal",
      providerId: "anthropic",
      displayName: "Personal",
      authMethod: "terminal",
      authState: "authenticated",
      lastCheckedAt: now,
      accessSourceId: "source_personal",
      dependencies: { activeChatCount: 2, resumableChatCount: 1, harnessInstanceCount: 1 },
    }],
    harnesses: [{
      id: "harness_hermes",
      harness: "hermes",
      displayName: "Hermes",
      accentColor: "teal",
      enabled: true,
      version: "1.8.0",
      installState: "installed",
      authState: "authenticated",
      loginMethods: ["terminal"],
      recommendedLoginMethod: "terminal",
      connectivity: "online",
      accountIds: ["account_personal"],
      selectedAccountId: null,
      accessSourceId: "source_matrix",
      route: {
        kind: "configurable",
        providerId: "anthropic",
        modelId: "anthropic/claude-opus-5",
      },
      activeChatCount: 2,
    }],
    gatewayPolicy: {
      accessSourceId: "source_matrix",
      monthlyBudgetMicrousd: 1_000_000,
      allowedModelIds: ["anthropic/claude-opus-5"],
      topUpEnabled: true,
    },
  };
}

const mutationBase = { expectedRevision: 12, idempotencyKey: "mutation_123" } as const;
const dependencyGuard = {
  activeChatCount: 2,
  resumableChatCount: 1,
  harnessInstanceCount: 1,
} as const;

describe("provider settings contracts", () => {
  it("accepts a secret-free UI mutation projection derived from V3", () => {
    expect(ProviderSettingsSnapshotSchema.parse(makeSnapshot())).toEqual(makeSnapshot());
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...makeSnapshot(),
      projectionOf: { contract: "different-contract", contractVersion: 3, revision: 12 },
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...makeSnapshot(),
      projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 11 },
    }).success).toBe(true);
    const unavailableLogin = makeSnapshot();
    unavailableLogin.harnesses[0]!.loginMethods = [];
    unavailableLogin.harnesses[0]!.recommendedLoginMethod = null;
    expect(ProviderSettingsSnapshotSchema.safeParse(unavailableLogin).success).toBe(true);
    unavailableLogin.harnesses[0]!.recommendedLoginMethod = "terminal";
    expect(ProviderSettingsSnapshotSchema.safeParse(unavailableLogin).success).toBe(false);
  });

  it("keeps accounts owner-funded, opaque, reciprocal, and secret-free", () => {
    const account = makeSnapshot().accounts[0]!;
    expect(ProviderAccountSchema.parse(account).id).toBe("account_personal");
    expect(ProviderAccountSchema.safeParse({ ...account, authMethod: "managed" }).success).toBe(false);
    expect(ProviderAccountSchema.safeParse({ ...account, apiKey: "sk-secret" }).success).toBe(false);
    expect(ProviderAccountSchema.safeParse({ ...account, displayName: "token=secret-value" }).success).toBe(false);

    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      accounts: [{ ...account, accessSourceId: "source_matrix" }],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      accessSources: snapshot.accessSources.map((source) =>
        source.id === "source_personal" ? { ...source, accountId: "account_other" } : source),
    }).success).toBe(false);
  });

  it("uses microusd and reconciles exact managed credit", () => {
    const usage = makeSnapshot().accessSources[0]!.usage;
    expect(ProviderUsageSchema.parse(usage).kind).toBe("managed_credit");
    expect(ProviderUsageSchema.safeParse({ ...usage, remainingMicrousd: 750_001 }).success).toBe(false);
    if (usage.kind !== "managed_credit") throw new Error("Expected managed credit fixture");
    expect(ProviderUsageSchema.safeParse({
      ...usage,
      credit: { ...usage.credit, addonBalanceMicrousd: 400_000 },
    }).success).toBe(false);
    expect(ProviderUsageSchema.safeParse({
      ...usage,
      budget: { ...usage.budget, remainingBudgetMicrousd: 700_000 },
    }).success).toBe(false);
    expect(ProviderUsageSchema.safeParse({ ...usage, remainingCents: 75 }).success).toBe(false);
  });

  it("represents authoritative, fresh metered and subscription usage", () => {
    expect(ProviderUsageSchema.safeParse({
      kind: "metered_api",
      authority: "matrix_observed",
      state: "stale",
      scope: "account",
      currency: "USD",
      observedUsageMicrousd: 425_000,
      providerBalance: {
        authority: "provider_balance",
        state: "current",
        remainingMicrousd: 900_000,
        asOf: now,
      },
      periodStartedAt: now,
      resetsAt: null,
      asOf: now,
    }).success).toBe(true);
    expect(ProviderUsageSchema.safeParse({
      kind: "subscription_allowance",
      authority: "provider_allowance",
      state: "current",
      scope: "account",
      usedBasisPoints: 7_500,
      resetsAt: later,
      asOf: now,
    }).success).toBe(true);
  });

  it("allows gateway usage to remain unavailable until the Matrix ledger exists", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      accessSources: snapshot.accessSources.map((source) => source.id === "source_matrix" ? {
        ...source,
        readiness: readiness("stale"),
        usage: {
          kind: "unavailable",
          authority: "unavailable",
          state: "unavailable",
          scope: "owner_entitlement",
          reason: "ledger_not_available",
          asOf: null,
        },
      } : source),
    }).success).toBe(true);
  });

  it("distinguishes included and add-on Matrix funding", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      accessSources: snapshot.accessSources.map((source) =>
        source.id === "source_matrix" ? { ...source, fundingKind: "matrix_addon" } : source),
    }).success).toBe(true);
  });

  it("rejects incoherent harness account and access-source selections", () => {
    const snapshot = makeSnapshot();
    const harness = snapshot.harnesses[0]!;
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{ ...harness, selectedAccountId: "account_personal" }],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{ ...harness, accessSourceId: "source_personal", selectedAccountId: null }],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{ ...harness, accessSourceId: "source_personal", selectedAccountId: "account_personal" }],
    }).success).toBe(true);
  });

  it("rejects disabled and gateway-disallowed route models", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      modelProviders: snapshot.modelProviders.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      gatewayPolicy: { ...snapshot.gatewayPolicy!, allowedModelIds: [] },
    }).success).toBe(false);
  });

  it("represents fixed routes but only permits model mutations on configurable routes", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{
        ...snapshot.harnesses[0]!,
        harness: "claude",
        route: { ...snapshot.harnesses[0]!.route, kind: "fixed" },
      }],
    }).success).toBe(true);
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "set_route",
      ...mutationBase,
      harnessInstanceId: "harness_hermes",
      route: { kind: "fixed", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      accessSourceId: "source_personal",
      accountId: "account_personal",
    }).success).toBe(false);
  });

  it("requires route, access source, and account to change atomically", () => {
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "set_route",
      ...mutationBase,
      harnessInstanceId: "harness_hermes",
      route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
    }).success).toBe(false);
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "set_route",
      ...mutationBase,
      harnessInstanceId: "harness_hermes",
      route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
      accessSourceId: "source_openai",
      accountId: "account_openai",
    }).success).toBe(true);
  });

  it.each(["missing", "installing", "failed", "unknown"] as const)(
    "accepts the %s install state",
    (installState) => {
      const snapshot = makeSnapshot();
      expect(ProviderSettingsSnapshotSchema.safeParse({
        ...snapshot,
        harnesses: [{
          ...snapshot.harnesses[0]!,
          enabled: false,
          version: null,
          installState,
          authState: "unknown",
          connectivity: "unknown",
          selectedAccountId: null,
          accessSourceId: null,
        }],
      }).success).toBe(true);
    },
  );

  it("represents offline and read-only settings explicitly", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      access: { mode: "read_only", reason: "remote_policy" },
      supportedActions: [],
      harnesses: snapshot.harnesses.map((harness) => ({ ...harness, connectivity: "offline" })),
    }).success).toBe(true);
  });

  it("advertises only explicit, unique mutation capabilities", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSupportedActionSchema.parse("set_route")).toBe("set_route");
    expect(snapshot.supportedActions).not.toContain("start_login");
    expect(snapshot.supportedActions).not.toContain("logout_account");
    expect(snapshot.supportedActions).not.toContain("remove_account");
    expect(snapshot.supportedActions).not.toContain("reassign_account");
    expect(snapshot.supportedActions).not.toContain("add_credit");
    expect(snapshot.supportedActions).not.toContain("submit_api_key");
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      supportedActions: [...snapshot.supportedActions, "set_route"],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      supportedActions: ["unknown_action"],
    }).success).toBe(false);
  });

  it("never advertises mutations while settings are read-only", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      access: { mode: "read_only", reason: "runtime_unavailable" },
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      access: { mode: "read_only", reason: "runtime_unavailable" },
      supportedActions: [],
    }).success).toBe(true);
  });

  it("requires an explicit capability before future credit or API-key UI exists", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      supportedActions: [...snapshot.supportedActions, "add_credit"],
    }).success).toBe(true);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      gatewayPolicy: { ...snapshot.gatewayPolicy!, topUpEnabled: false },
      supportedActions: [...snapshot.supportedActions, "add_credit"],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      supportedActions: [...snapshot.supportedActions, "submit_api_key"],
    }).success).toBe(false);
  });

  const mutations: ProviderSettingsMutation[] = [
    {
      type: "add_harness",
      ...mutationBase,
      harness: "opencode",
      displayName: "OpenCode",
      route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      accessSourceId: "source_matrix",
      accountId: null,
    },
    {
      type: "remove_harness",
      ...mutationBase,
      harnessInstanceId: "harness_hermes",
      confirmation: "remove_harness",
    },
    { type: "update_harness", ...mutationBase, harnessInstanceId: "harness_hermes", displayName: "Hermes Work" },
    { type: "set_harness_enabled", ...mutationBase, harnessInstanceId: "harness_hermes", enabled: false },
    {
      type: "set_route",
      ...mutationBase,
      harnessInstanceId: "harness_hermes",
      route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      accessSourceId: "source_personal",
      accountId: "account_personal",
    },
    { type: "select_account", ...mutationBase, harnessInstanceId: "harness_hermes", accountId: "account_personal" },
    { type: "select_access_source", ...mutationBase, harnessInstanceId: "harness_hermes", accessSourceId: "source_matrix" },
    { type: "start_login", ...mutationBase, harnessInstanceId: "harness_hermes", accountId: null, method: "terminal" },
    { type: "logout_account", ...mutationBase, accountId: "account_personal" },
    {
      type: "remove_account",
      ...mutationBase,
      accountId: "account_personal",
      dependencyGuard,
      confirmation: "remove_account",
    },
    {
      type: "reassign_account",
      ...mutationBase,
      fromAccountId: "account_personal",
      target: { kind: "access_source", accessSourceId: "source_matrix" },
      scope: "all_dependencies",
      dependencyGuard,
    },
    { type: "set_gateway_budget", ...mutationBase, monthlyBudgetMicrousd: 2_000_000 },
    {
      type: "set_gateway_allowlist",
      ...mutationBase,
      allowedModelIds: ["anthropic/claude-opus-5"],
    },
  ];

  it.each(mutations)("accepts the revisioned, idempotent $type mutation", (mutation) => {
    expect(ProviderSettingsMutationSchema.safeParse(mutation).success).toBe(true);
  });

  it("requires idempotency, dependency guards, and explicit removal confirmation", () => {
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "set_gateway_budget",
      expectedRevision: 12,
      monthlyBudgetMicrousd: 2_000_000,
    }).success).toBe(false);
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "remove_account",
      ...mutationBase,
      accountId: "account_personal",
      dependencyGuard,
    }).success).toBe(false);
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "remove_harness",
      ...mutationBase,
      harnessInstanceId: "harness_hermes",
    }).success).toBe(false);
  });

  it("requires an explicit route and access source when adding a harness", () => {
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "add_harness",
      ...mutationBase,
      harness: "opencode",
      displayName: "OpenCode",
      accountId: null,
    }).success).toBe(false);
  });

  it("returns a safe connection attempt that can launch a visible terminal", () => {
    const attempt = {
      id: "attempt_123",
      harnessInstanceId: "harness_hermes",
      accountId: null,
      method: "terminal",
      state: "pending",
      action: { kind: "open_terminal", terminalSessionId: "provider-login-123" },
      expiresAt: later,
      safeFailure: null,
    } as const;
    expect(ProviderConnectionAttemptSchema.parse(attempt)).toEqual(attempt);
    expect(ProviderSettingsMutationResponseSchema.safeParse({
      kind: "login_attempt",
      snapshot: makeSnapshot(),
      attempt,
    }).success).toBe(true);
    expect(ProviderConnectionAttemptSchema.safeParse({ ...attempt, apiKey: "sk-secret" }).success).toBe(false);
  });

  it("represents browser login with an owner-gateway path, never a credential-bearing URL", () => {
    expect(ProviderConnectionAttemptActionSchema.safeParse({
      kind: "open_browser",
      authorizationPath: "/api/ai/providers/login-attempts/attempt_123/authorize",
    }).success).toBe(true);
    expect(ProviderConnectionAttemptActionSchema.safeParse({
      kind: "open_browser",
      authorizationUrl: "https://provider.example/authorize?access_token=secret",
    }).success).toBe(false);
  });
});
