import {
  ProviderSettingsSnapshotSchema,
  type AiProviderReadiness,
  type AiProviderSnapshotV3,
  type FundedAiEffectivePolicy,
  type FundedAiFundingSummary,
  type ProviderAccount,
  type ProviderDependencyCounts,
  type ProviderHarnessInstance,
  type ProviderHarnessKind,
  type ProviderLoginMethod,
  type ProviderSettingsSupportedAction,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import type { HarnessConfiguration, ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import { resolveProviderSettingsDriverId } from "./provider-settings-driver-id.js";

export interface ProviderSettingsDependencyReader {
  getAccountDependencies(input: {
    accountId: string;
    harnessInstanceIds: string[];
  }): Promise<ProviderDependencyCounts>;
}

function authState(readiness: AiProviderReadiness): ProviderHarnessInstance["authState"] {
  if (readiness.state === "ready") return "authenticated";
  if (readiness.state === "expired") return "expired";
  if (readiness.state === "invalid") return "failed";
  if (["setup_required", "auth_required", "disabled"].includes(readiness.state)) return "unauthenticated";
  return "unknown";
}

function connectivity(readiness: AiProviderReadiness): ProviderHarnessInstance["connectivity"] {
  if (readiness.state === "ready") return "online";
  if (readiness.state === "stale") return "degraded";
  if (readiness.state === "unavailable" || readiness.state === "disabled") return "offline";
  return "unknown";
}

function defaultLoginMethods(kind: ProviderHarnessKind) {
  return kind === "codex"
    ? ["terminal", "oauth", "api_key"] as const
    : ["terminal", "api_key"] as const;
}

function selectedCanonicalSources(
  canonical: AiProviderSnapshotV3,
  config: ProviderSettingsConfiguration,
) {
  const sourceByAccount = new Map<string, string>();
  for (const account of canonical.accounts) {
    const stored = config.accountProfiles.find((profile) => profile.id === account.id);
    if (account.authMethod === null && !stored) continue;
    const instance = canonical.instances.find((candidate) => {
      if (candidate.accountId !== account.id) return false;
      const source = canonical.accessSources.find((value) => value.id === candidate.accessSourceId);
      return account.authMethod === "api_key" || stored?.authMethod === "api_key"
        ? source?.fundingKind === "owner_api_key"
        : source?.fundingKind === "owner_account";
    });
    const accessSourceId = instance?.accessSourceId ?? stored?.accessSourceId;
    if (accessSourceId) sourceByAccount.set(account.id, accessSourceId);
  }
  const sourceIds = new Set([
    ...canonical.accessSources
      .filter((source) => source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon")
      .map((source) => source.id),
    ...sourceByAccount.values(),
  ]);
  return { sourceByAccount, sourceIds };
}

function projectAccessSources(
  canonical: AiProviderSnapshotV3,
  config: ProviderSettingsConfiguration,
  fundingSummary?: FundedAiFundingSummary,
  fundedPolicy?: FundedAiEffectivePolicy,
  fundedPolicyAuthoritative = false,
  now = new Date(),
) {
  const { sourceByAccount, sourceIds } = selectedCanonicalSources(canonical, config);
  const accountBySource = new Map([...sourceByAccount].map(([accountId, sourceId]) => [sourceId, accountId]));
  const sources = canonical.accessSources.filter((source) => sourceIds.has(source.id)).map((source) => {
    const matrix = source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon";
    // Platform policy replaces the bundled Matrix allowlist. The canonical
    // catalog still bounds projection to runnable models for this vendor.
    const availableModelIds = matrix && fundedPolicyAuthoritative
      ? new Set(canonical.models
        .filter((model) => model.vendor === source.vendor
          && model.status !== "retired" && model.status !== "unavailable")
        .map((model) => model.id))
      : null;
    const fundedModelIds = availableModelIds
      ? (fundedPolicy?.allowedModelIds ?? []).flatMap((policyModelId) => {
        if (availableModelIds.has(policyModelId)) return [policyModelId];
        const vendorPrefix = `${source.vendor}/`;
        const canonicalModelId = policyModelId.startsWith(vendorPrefix)
          ? policyModelId.slice(vendorPrefix.length)
          : null;
        return canonicalModelId && availableModelIds.has(canonicalModelId)
          ? [canonicalModelId]
          : [];
      })
      : null;
    return {
      id: source.id,
      kind: matrix ? "matrix_gateway" as const : "provider_account" as const,
      fundingKind: source.fundingKind,
      providerId: source.vendor,
      accountId: accountBySource.get(source.id) ?? null,
      displayName: source.displayName,
      readiness: {
        state: source.state,
        checkedAt: source.checkedAt,
        staleAfter: source.staleAfter,
        action: source.action,
        safeReason: source.safeReason,
      },
      eligibleModelIds: fundedModelIds
        ? [...new Set(fundedModelIds)]
        : [...source.eligibleModelIds],
      usage: matrix && fundingSummary ? {
        kind: "managed_credit" as const,
        authority: "matrix_ledger" as const,
        state: fundingState(fundingSummary.asOf, now),
        scope: "owner_entitlement" as const,
        currency: "USD",
        usedMicrousd: fundingSummary.settledThisMonthMicrousd,
        remainingMicrousd: Math.min(
          fundingSummary.remainingBalanceMicrousd,
          fundingSummary.remainingBudgetMicrousd,
        ),
        limitMicrousd: fundingSummary.monthlyBudgetMicrousd,
        periodStartedAt: fundingSummary.periodStart,
        resetsAt: nextUtcMonth(fundingSummary.periodStart),
        asOf: fundingSummary.asOf,
        credit: {
          promotionalBalanceMicrousd: fundingSummary.promotionalBalanceMicrousd,
          addonBalanceMicrousd: fundingSummary.addonBalanceMicrousd,
          creditBalanceMicrousd: fundingSummary.creditBalanceMicrousd,
          reservedMicrousd: fundingSummary.reservedMicrousd,
          remainingBalanceMicrousd: fundingSummary.remainingBalanceMicrousd,
        },
        budget: {
          monthlyBudgetMicrousd: fundingSummary.monthlyBudgetMicrousd,
          settledThisMonthMicrousd: fundingSummary.settledThisMonthMicrousd,
          reservedThisMonthMicrousd: fundingSummary.reservedThisMonthMicrousd,
          remainingBudgetMicrousd: fundingSummary.remainingBudgetMicrousd,
        },
      } : {
        kind: "unavailable" as const,
        authority: "unavailable" as const,
        state: "unavailable" as const,
        scope: matrix ? "owner_entitlement" as const : "account" as const,
        reason: matrix ? "ledger_not_available" as const
          : source.state === "ready" ? "provider_does_not_report" as const : "not_authenticated" as const,
        asOf: null,
      },
    };
  });
  return { sources, sourceByAccount };
}

function nextUtcMonth(periodStart: string): string {
  const start = new Date(periodStart);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
}

function fundingState(asOf: string, now: Date): "current" | "stale" {
  const age = now.getTime() - Date.parse(asOf);
  return Number.isFinite(age) && age >= -60_000 && age <= 5 * 60_000 ? "current" : "stale";
}

async function projectAccounts(input: {
  canonical: AiProviderSnapshotV3;
  config: ProviderSettingsConfiguration;
  sourceByAccount: Map<string, string>;
  sourceIds: Set<string>;
  dependencies?: ProviderSettingsDependencyReader;
}): Promise<ProviderAccount[]> {
  const accounts = await Promise.all(input.canonical.accounts.map(async (account): Promise<ProviderAccount | null> => {
    const accessSourceId = input.sourceByAccount.get(account.id);
    const stored = input.config.accountProfiles.find((profile) => profile.id === account.id);
    if (!accessSourceId || !input.sourceIds.has(accessSourceId) || (account.authMethod === null && !stored)) return null;
    const selectedHarnesses = input.config.harnesses.filter((harness) => harness.selectedAccountId === account.id);
    const dependencies = input.dependencies
      ? await input.dependencies.getAccountDependencies({
          accountId: account.id,
          harnessInstanceIds: selectedHarnesses.map((harness) => harness.id),
        })
      : { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: selectedHarnesses.length };
    return {
      id: account.id,
      providerId: account.vendor,
      displayName: account.accountLabel ?? stored?.displayName ?? `${account.vendor} account`,
      authMethod: account.authMethod === "provider_profile" ? "terminal"
        : account.authMethod === "oauth_pkce" ? "oauth"
          : account.authMethod === "api_key" ? "api_key" : stored!.authMethod,
      authState: authState(account),
      lastCheckedAt: account.checkedAt,
      accessSourceId,
      dependencies,
    };
  }));
  return accounts.filter((account): account is ProviderAccount => account !== null);
}

function projectHarness(input: {
  stored: HarnessConfiguration;
  canonical: AiProviderSnapshotV3;
  accounts: ProviderAccount[];
  sources: ReturnType<typeof projectAccessSources>["sources"];
  allowedGatewayModels: ReadonlySet<string>;
  loginMethods?: (harness: HarnessConfiguration) => readonly ProviderLoginMethod[];
}): ProviderHarnessInstance | null {
  const model = input.canonical.models.find((candidate) => candidate.id === input.stored.route.modelId);
  if (!model || model.vendor !== input.stored.route.providerId) return null;
  const driverId = resolveProviderSettingsDriverId({
    driverId: input.stored.driverId,
    harness: input.stored.harness,
    canonical: input.canonical,
  });
  const driver = input.canonical.drivers.find((candidate) => candidate.id === driverId);
  const source = input.stored.accessSourceId === null
    ? undefined
    : input.sources.find((candidate) => candidate.id === input.stored.accessSourceId);
  const sourceEligible = source?.providerId === input.stored.route.providerId
    && source.eligibleModelIds.includes(input.stored.route.modelId)
    && (source.kind !== "matrix_gateway" || input.allowedGatewayModels.has(input.stored.route.modelId));
  const selectedAccountId = sourceEligible && source?.kind === "provider_account"
    && source.accountId && input.accounts.some((account) => account.id === source.accountId)
    ? source.accountId : null;
  const readiness = sourceEligible ? source.readiness : {
    state: "unknown" as const,
    checkedAt: null,
    staleAfter: null,
    action: "retry" as const,
    safeReason: "unknown" as const,
  };
  const accounts = input.accounts.filter((account) => account.providerId === input.stored.route.providerId);
  const visibleMethods = input.loginMethods === undefined
    ? defaultLoginMethods(input.stored.harness)
    : input.loginMethods(input.stored);
  return {
    id: input.stored.id,
    harness: input.stored.harness,
    displayName: input.stored.displayName,
    accentColor: input.stored.accentColor,
    enabled: Boolean(input.stored.enabled && driver?.installState === "installed"),
    version: null,
    installState: driver?.installState ?? "missing",
    authState: authState(readiness),
    loginMethods: [...visibleMethods],
    recommendedLoginMethod: visibleMethods[0] ?? null,
    connectivity: connectivity(readiness),
    accountIds: accounts.map((account) => account.id),
    selectedAccountId,
    accessSourceId: sourceEligible ? source!.id : null,
    route: input.stored.route,
    activeChatCount: selectedAccountId
      ? accounts.find((account) => account.id === selectedAccountId)!.dependencies.activeChatCount
      : 0,
  };
}

export async function projectProviderSettings(input: {
  canonical: AiProviderSnapshotV3;
  config: ProviderSettingsConfiguration;
  now: Date;
  dependencies?: ProviderSettingsDependencyReader;
  supportedActions: ProviderSettingsSupportedAction[];
  fundingSummary?: FundedAiFundingSummary;
  fundedPolicy?: FundedAiEffectivePolicy;
  fundedPolicyAuthoritative?: boolean;
  loginMethods?: (harness: HarnessConfiguration) => readonly ProviderLoginMethod[];
}): Promise<ProviderSettingsSnapshot> {
  const { sources, sourceByAccount } = projectAccessSources(
    input.canonical,
    input.config,
    input.fundingSummary,
    input.fundedPolicy,
    input.fundedPolicyAuthoritative,
    input.now,
  );
  const accounts = await projectAccounts({
    canonical: input.canonical,
    config: input.config,
    sourceByAccount,
    sourceIds: new Set(sources.map((source) => source.id)),
    dependencies: input.dependencies,
  });
  const modelsByVendor = new Map<string, typeof input.canonical.models>();
  for (const model of input.canonical.models) {
    modelsByVendor.set(model.vendor, [...(modelsByVendor.get(model.vendor) ?? []), model]);
  }
  const modelProviders = [...modelsByVendor].map(([id, models]) => ({
    id,
    displayName: id[0]!.toUpperCase() + id.slice(1),
    models: models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      enabled: model.status !== "retired" && model.status !== "unavailable",
    })),
  }));
  const gatewayPolicy = input.config.gatewayPolicy
    && sources.some((source) => source.id === input.config.gatewayPolicy?.accessSourceId && source.kind === "matrix_gateway")
    ? {
        ...input.config.gatewayPolicy,
        allowedModelIds: input.fundedPolicyAuthoritative
          ? sources.find((source) => source.id === input.config.gatewayPolicy?.accessSourceId)!
            .eligibleModelIds
          : input.config.gatewayPolicy.allowedModelIds,
        monthlyBudgetMicrousd: input.fundingSummary?.monthlyBudgetMicrousd
          ?? input.config.gatewayPolicy.monthlyBudgetMicrousd,
        // Stripe top-ups are not wired yet; schemas alone never advertise purchase capability.
        topUpEnabled: false,
      } : null;
  const allowedGatewayModels = new Set(gatewayPolicy?.allowedModelIds ?? []);
  const harnesses = input.config.harnesses.flatMap((stored) => {
    const harness = projectHarness({
      stored,
      canonical: input.canonical,
      accounts,
      sources,
      allowedGatewayModels,
      loginMethods: input.loginMethods,
    });
    return harness ? [harness] : [];
  });
  return ProviderSettingsSnapshotSchema.parse({
    contractVersion: 1,
    projectionOf: {
      contract: "AiProviderSnapshotV3",
      contractVersion: 3,
      revision: input.canonical.revision,
    },
    revision: input.config.revision,
    refreshedAt: input.now.toISOString(),
    access: input.supportedActions.length > 0
      ? { mode: "writable" }
      : { mode: "read_only", reason: "runtime_unavailable" },
    supportedActions: input.supportedActions,
    modelProviders,
    accessSources: sources,
    accounts,
    harnesses,
    gatewayPolicy,
  });
}
