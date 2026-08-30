import { describe, expect, it } from "vitest";
import {
  ProviderAccessSourceSchema,
  ProviderAccountSchema,
  ProviderHarnessInstanceSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  ProviderUsageSchema,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";

const now = "2026-08-30T10:00:00.000Z";

function makeSnapshot(): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    revision: 12,
    refreshedAt: now,
    access: { mode: "writable" },
    modelProviders: [{
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "anthropic/claude-opus-5", displayName: "Claude Opus 5", enabled: true }],
    }],
    accessSources: [{
      id: "source_matrix",
      kind: "matrix_gateway",
      providerId: "anthropic",
      accountId: null,
      displayName: "Matrix AI included credit",
      eligibleModelIds: ["anthropic/claude-opus-5"],
      usage: {
        kind: "managed_credit",
        currency: "USD",
        usedCents: 250,
        remainingCents: 750,
        limitCents: 1_000,
        periodStartedAt: now,
        resetsAt: "2026-09-30T10:00:00.000Z",
      },
    }],
    accounts: [{
      id: "account_personal",
      providerId: "anthropic",
      displayName: "Personal",
      authMethod: "managed",
      authState: "authenticated",
      lastCheckedAt: now,
      accessSourceId: "source_matrix",
      activeChatCount: 2,
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
      selectedAccountId: "account_personal",
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
      monthlyBudgetCents: 1_000,
      allowedModelIds: ["anthropic/claude-opus-5"],
      topUpEnabled: true,
    },
  };
}

describe("provider settings contracts", () => {
  it("accepts a complete secret-free Agents & providers snapshot", () => {
    expect(ProviderSettingsSnapshotSchema.parse(makeSnapshot())).toEqual(makeSnapshot());
  });

  it("keeps account identifiers opaque and rejects credential material", () => {
    const account = makeSnapshot().accounts[0]!;
    expect(ProviderAccountSchema.parse(account).id).toBe("account_personal");
    expect(ProviderAccountSchema.safeParse({ ...account, apiKey: "sk-secret" }).success).toBe(false);
    expect(ProviderAccountSchema.safeParse({ ...account, accessToken: "opaque-secret" }).success).toBe(false);
    expect(ProviderAccountSchema.safeParse({ ...account, displayName: "token=secret-value" }).success).toBe(false);
  });

  it("models exact managed credit without permitting inconsistent totals", () => {
    const usage = makeSnapshot().accessSources[0]!.usage;
    expect(ProviderUsageSchema.parse(usage).kind).toBe("managed_credit");
    expect(ProviderUsageSchema.safeParse({ ...usage, remainingCents: 751 }).success).toBe(false);
  });

  it("represents metered APIs, subscriptions, and unavailable usage without inventing balances", () => {
    expect(ProviderUsageSchema.safeParse({
      kind: "metered_api",
      currency: "USD",
      observedUsageCents: 425,
      providerBalanceCents: null,
      periodStartedAt: now,
      resetsAt: null,
    }).success).toBe(true);
    expect(ProviderUsageSchema.safeParse({
      kind: "subscription_allowance",
      usedBasisPoints: 7_500,
      resetsAt: "2026-09-01T00:00:00.000Z",
    }).success).toBe(true);
    expect(ProviderUsageSchema.safeParse({
      kind: "unavailable",
      reason: "provider_does_not_report",
    }).success).toBe(true);
    expect(ProviderUsageSchema.safeParse({
      kind: "unavailable",
      reason: "provider_does_not_report",
      balanceCents: 10,
    }).success).toBe(false);
  });

  it("supports configurable and model-specific fixed harness routes", () => {
    const configurable = makeSnapshot().harnesses[0]!;
    expect(ProviderHarnessInstanceSchema.safeParse(configurable).success).toBe(true);
    expect(ProviderHarnessInstanceSchema.safeParse({
      ...configurable,
      harness: "claude",
      route: {
        kind: "fixed",
        providerId: "anthropic",
        modelId: "anthropic/claude-opus-5",
      },
    }).success).toBe(true);
  });

  it.each([
    "missing",
    "installing",
    "failed",
    "unknown",
  ] as const)("accepts the %s install state", (installState) => {
    expect(ProviderHarnessInstanceSchema.safeParse({
      ...makeSnapshot().harnesses[0],
      enabled: false,
      version: null,
      installState,
      authState: "unknown",
      connectivity: "unknown",
      selectedAccountId: null,
      accessSourceId: null,
    }).success).toBe(true);
  });

  it.each(["authenticating", "unauthenticated", "expired", "failed"] as const)(
    "accepts the %s authentication state",
    (authState) => {
      expect(ProviderAccountSchema.safeParse({
        ...makeSnapshot().accounts[0],
        authState,
      }).success).toBe(true);
    },
  );

  it("represents offline and read-only settings explicitly", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      access: { mode: "read_only", reason: "remote_policy" },
      harnesses: snapshot.harnesses.map((harness) => ({ ...harness, connectivity: "offline" })),
    }).success).toBe(true);
  });

  it("rejects broken account, source, route, and model references", () => {
    const snapshot = makeSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{ ...snapshot.harnesses[0]!, selectedAccountId: "account_missing" }],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{ ...snapshot.harnesses[0]!, accessSourceId: "source_missing" }],
    }).success).toBe(false);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...snapshot,
      harnesses: [{
        ...snapshot.harnesses[0]!,
        route: { kind: "configurable", providerId: "anthropic", modelId: "unknown/model" },
      }],
    }).success).toBe(false);
  });

  it("requires a managed gateway source for gateway policy", () => {
    const source = makeSnapshot().accessSources[0]!;
    expect(ProviderAccessSourceSchema.safeParse(source).success).toBe(true);
    expect(ProviderSettingsSnapshotSchema.safeParse({
      ...makeSnapshot(),
      accessSources: [{ ...source, kind: "provider_account" }],
    }).success).toBe(false);
  });

  it.each([
    { type: "add_harness", expectedRevision: 12, harness: "opencode", displayName: "OpenCode", accountId: null },
    { type: "update_harness", expectedRevision: 12, harnessInstanceId: "harness_hermes", displayName: "Hermes Work" },
    { type: "set_harness_enabled", expectedRevision: 12, harnessInstanceId: "harness_hermes", enabled: false },
    {
      type: "set_route",
      expectedRevision: 12,
      harnessInstanceId: "harness_hermes",
      route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
    },
    { type: "select_account", expectedRevision: 12, harnessInstanceId: "harness_hermes", accountId: "account_personal" },
    { type: "start_login", expectedRevision: 12, harnessInstanceId: "harness_hermes", accountId: null, method: "terminal" },
    { type: "logout_account", expectedRevision: 12, accountId: "account_personal" },
    { type: "remove_account", expectedRevision: 12, accountId: "account_personal" },
    {
      type: "reassign_account",
      expectedRevision: 12,
      fromAccountId: "account_personal",
      toAccountId: "account_work",
      scope: "all_dependencies",
    },
    { type: "set_gateway_budget", expectedRevision: 12, monthlyBudgetCents: 2_000 },
    {
      type: "set_gateway_allowlist",
      expectedRevision: 12,
      allowedModelIds: ["anthropic/claude-opus-5"],
    },
  ])("accepts the revisioned $type mutation", (mutation) => {
    expect(ProviderSettingsMutationSchema.safeParse(mutation).success).toBe(true);
  });

  it("rejects stale-free and secret-bearing mutations", () => {
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "set_gateway_budget",
      monthlyBudgetCents: 2_000,
    }).success).toBe(false);
    expect(ProviderSettingsMutationSchema.safeParse({
      type: "start_login",
      expectedRevision: 12,
      harnessInstanceId: "harness_hermes",
      accountId: null,
      method: "api_key",
      apiKey: "sk-secret",
    }).success).toBe(false);
  });
});
