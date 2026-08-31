import {
  ProviderSettingsSnapshotSchema,
  type AiProviderReadiness,
  type AiProviderSnapshotV3,
  type FundedAiEffectivePolicy,
  type FundedAiFundingSummary,
  type ProviderAccount,
  type ProviderAccessSource,
  type ProviderDependencyCounts,
  type ProviderHarnessInstance,
  type ProviderHarnessKind,
  type ProviderHarnessCatalogEntry,
  type ProviderLoginMethod,
  type ProviderSettingsSupportedAction,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import type { HarnessConfiguration, ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import { resolveProviderSettingsDriverId } from "./provider-settings-driver-id.js";
import type { GenericHarnessModelCatalog } from "./generic-harness-model-catalog.js";

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
    // catalog still bounds projection to runnable models assigned to this
    // exact access source; vendor membership alone is not route eligibility.
    const availableModelIds = matrix && fundedPolicyAuthoritative
      ? new Set(canonical.models
        .filter((model) => model.vendor === source.vendor
          && model.status !== "retired" && model.status !== "unavailable"
          && source.eligibleModelIds.includes(model.id)
          && model.eligibleAccessSourceIds.includes(source.id))
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
          ...(fundingSummary.fundingShortfallMicrousd === undefined
            ? {}
            : { fundingShortfallMicrousd: fundingSummary.fundingShortfallMicrousd }),
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

function fallbackRouteLabel(reference: string, fallback: string): string {
  const leaf = reference.split(/[/:]/).at(-1) ?? reference;
  const label = leaf.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const value = label || fallback;
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`.slice(0, 120);
}

function retainFailedCatalogRoutes(input: {
  modelProviders: ProviderSettingsSnapshot["modelProviders"];
  sources: ProviderAccessSource[];
  config: ProviderSettingsConfiguration;
  failures: ReadonlySet<ProviderHarnessKind>;
  canonicalProviderIds: ReadonlySet<string>;
}): void {
  const referencedProviders = new Set(input.config.harnesses.map((harness) => harness.route.providerId));
  const referencedModels = new Set(input.config.harnesses.map((harness) => harness.route.modelId));
  for (const harness of input.config.harnesses) {
    if (!input.failures.has(harness.harness)) continue;
    let provider = input.modelProviders.find((candidate) => candidate.id === harness.route.providerId);
    if (!provider) {
      while (input.modelProviders.length >= 32) {
        const removable = input.modelProviders.findLastIndex((candidate) =>
          !input.canonicalProviderIds.has(candidate.id)
          && !referencedProviders.has(candidate.id));
        if (removable < 0) break;
        const [removed] = input.modelProviders.splice(removable, 1);
        for (let index = input.sources.length - 1; index >= 0; index -= 1) {
          const source = input.sources[index]!;
          if (source.kind === "harness_profile" && source.providerId === removed!.id) {
            input.sources.splice(index, 1);
          }
        }
      }
      if (input.modelProviders.length >= 32) continue;
      provider = {
        id: harness.route.providerId,
        displayName: fallbackRouteLabel(harness.route.providerId, "Unavailable provider"),
        models: [],
      };
      input.modelProviders.push(provider);
    }
    if (provider.models.some((model) => model.id === harness.route.modelId)) continue;
    if (provider.models.length >= 256) {
      const removable = provider.models.findLastIndex((model) => !referencedModels.has(model.id));
      if (removable < 0) continue;
      provider.models.splice(removable, 1);
    }
    provider.models.push({
      id: harness.route.modelId,
      displayName: fallbackRouteLabel(harness.route.modelId, "Unavailable model"),
      enabled: true,
    });
  }
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
  modelProviders: ProviderSettingsSnapshot["modelProviders"];
  accounts: ProviderAccount[];
  sources: ProviderAccessSource[];
  allowedGatewayModels: ReadonlySet<string>;
  catalogUnavailable: boolean;
  loginMethods?: (harness: HarnessConfiguration) => readonly ProviderLoginMethod[];
}): ProviderHarnessInstance | null {
  const modelProvider = input.modelProviders.find((candidate) => candidate.id === input.stored.route.providerId);
  const model = modelProvider?.models.find((candidate) => candidate.id === input.stored.route.modelId);
  const routeAvailable = model?.enabled === true;
  if (!routeAvailable && !input.catalogUnavailable) return null;
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
    && (source.kind !== "harness_profile" || source.harness === input.stored.harness)
    && (source.kind !== "matrix_gateway" || input.allowedGatewayModels.has(input.stored.route.modelId));
  const routeCatalogUnavailable = input.catalogUnavailable || !routeAvailable;
  const routeSourceEligible = sourceEligible === true && !routeCatalogUnavailable;
  const selectedAccountId = routeSourceEligible && source?.kind === "provider_account"
    && source.accountId && input.accounts.some((account) => account.id === source.accountId)
    ? source.accountId : null;
  const readiness = routeSourceEligible ? source!.readiness : {
    state: input.catalogUnavailable ? "unavailable" as const : "unknown" as const,
    checkedAt: null,
    staleAfter: null,
    action: "retry" as const,
    safeReason: input.catalogUnavailable ? "provider_unavailable" as const : "unknown" as const,
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
    enabled: Boolean(routeAvailable && !routeCatalogUnavailable
      && input.stored.enabled && driver?.installState === "installed"),
    version: null,
    installState: driver?.installState ?? "missing",
    authState: authState(readiness),
    loginMethods: [...visibleMethods],
    recommendedLoginMethod: visibleMethods[0] ?? null,
    connectivity: connectivity(readiness),
    accountIds: accounts.map((account) => account.id),
    selectedAccountId,
    accessSourceId: routeSourceEligible ? source!.id : null,
    route: input.stored.route,
    routeAvailability: routeCatalogUnavailable ? "catalog_unavailable" : "available",
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
  genericModelCatalog?: GenericHarnessModelCatalog;
  configurationHarnessKinds?: ProviderHarnessKind[];
  loginMethods?: (harness: HarnessConfiguration) => readonly ProviderLoginMethod[];
}): Promise<ProviderSettingsSnapshot> {
  const supportedActions = input.fundingSummary?.topUpEnabled === true
    && !input.supportedActions.includes("add_credit")
    ? [...input.supportedActions, "add_credit" as const]
    : input.supportedActions;
  const projected = projectAccessSources(
    input.canonical,
    input.config,
    input.fundingSummary,
    input.fundedPolicy,
    input.fundedPolicyAuthoritative,
    input.now,
  );
  const sources: ProviderAccessSource[] = [
    ...projected.sources,
    ...(input.genericModelCatalog?.accessSources ?? []).filter((source) =>
      !projected.sources.some((candidate) => candidate.id === source.id)),
  ];
  const sourceByAccount = projected.sourceByAccount;
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
  const canonicalProviderIds = new Set(modelProviders.map((provider) => provider.id));
  for (const discovered of input.genericModelCatalog?.providers ?? []) {
    const existing = modelProviders.find((provider) => provider.id === discovered.id);
    if (!existing) {
      modelProviders.push({
        ...discovered,
        models: discovered.models.map((model) => ({ ...model })),
      });
      continue;
    }
    for (const model of discovered.models) {
      if (!existing.models.some((candidate) => candidate.id === model.id)) {
        existing.models.push({ ...model });
      }
    }
  }
  const failedCatalogs = new Set<ProviderHarnessKind>(input.genericModelCatalog?.failures ?? []);
  retainFailedCatalogRoutes({
    modelProviders,
    sources,
    config: input.config,
    failures: failedCatalogs,
    canonicalProviderIds,
  });
  modelProviders.sort((left, right) => left.displayName.localeCompare(right.displayName));
  const gatewayPolicy = input.config.gatewayPolicy
    && sources.some((source) => source.id === input.config.gatewayPolicy?.accessSourceId && source.kind === "matrix_gateway")
    ? {
        ...input.config.gatewayPolicy,
        allowedModelIds: input.fundedPolicyAuthoritative
          ? sources.find((source) => source.id === input.config.gatewayPolicy?.accessSourceId)!
            .eligibleModelIds
          : input.config.gatewayPolicy.allowedModelIds,
        monthlyBudgetMicrousd: input.fundedPolicyAuthoritative
          ? input.fundingSummary?.monthlyBudgetMicrousd ?? null
          : input.config.gatewayPolicy.monthlyBudgetMicrousd,
        // Only the machine-authenticated platform funding response can enable
        // purchase. Owner-controlled provider JSON remains incapable of doing so.
        topUpEnabled: input.fundingSummary?.topUpEnabled === true,
      } : null;
  const allowedGatewayModels = new Set(gatewayPolicy?.allowedModelIds ?? []);
  const harnessCatalog = projectHarnessCatalog(
    input.canonical,
    input.configurationHarnessKinds ?? [],
  );
  const harnesses = input.config.harnesses.flatMap((stored) => {
    const harness = projectHarness({
      stored,
      canonical: input.canonical,
      modelProviders,
      accounts,
      sources,
      allowedGatewayModels,
      catalogUnavailable: failedCatalogs.has(stored.harness),
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
    access: supportedActions.length > 0
      ? { mode: "writable" }
      : { mode: "read_only", reason: "runtime_unavailable" },
    supportedActions,
    configurationHarnessKinds: input.configurationHarnessKinds ?? [],
    harnessCatalog,
    modelProviders,
    accessSources: sources,
    accounts,
    harnesses,
    gatewayPolicy,
  });
}

const GENERIC_HARNESS_CATALOG = [
  { harness: "hermes", displayName: "Hermes", system: true },
  { harness: "openclaw", displayName: "OpenClaw", system: true },
  { harness: "pi", displayName: "Pi", system: false },
  { harness: "opencode", displayName: "OpenCode", system: false },
] as const;

type GenericHarnessCatalogDefinition = (typeof GENERIC_HARNESS_CATALOG)[number];
type CanonicalDriver = AiProviderSnapshotV3["drivers"][number];

function catalogDriverRunnable(
  catalog: GenericHarnessCatalogDefinition,
  driver: CanonicalDriver | undefined,
): boolean {
  if (!driver || driver.installState !== "installed") return false;
  // Pi and OpenCode receive credentials from the access source selected while
  // adding the harness. Their installation probe intentionally cannot prove
  // that future route credential, so a registered direct adapter reports
  // unknown health until the first configured run. Match the runtime
  // coordinator's admission rule here instead of creating a setup deadlock.
  if (!catalog.system) return driver.health !== "unavailable" && driver.health !== "stopped";
  return driver.health === "ready" || driver.health === "degraded"
    || (driver.health === "stopped" && driver.setupActions.length === 0);
}

function catalogSafeReason(
  driver: CanonicalDriver | undefined,
): Exclude<ProviderHarnessCatalogEntry["safeReason"], null> {
  if (!driver || driver.installState === "missing") return "not_installed";
  if (driver.installState === "installing") return "installing";
  if (driver.installState === "failed") return "install_failed";
  if (driver.installState === "unknown") return "install_state_unknown";
  if (driver.health === "unavailable" || driver.health === "unknown") return "runtime_unavailable";
  return "setup_required";
}

function projectHarnessCatalog(
  canonical: AiProviderSnapshotV3,
  supportedKinds: readonly ProviderHarnessKind[],
): ProviderHarnessCatalogEntry[] {
  const supported = new Set(supportedKinds);
  return GENERIC_HARNESS_CATALOG.map((catalog): ProviderHarnessCatalogEntry => {
    const driver = canonical.drivers.find((candidate) => candidate.id === catalog.harness);
    const installState = driver?.installState ?? "missing";
    if (!supported.has(catalog.harness)) {
      return {
        harness: catalog.harness,
        displayName: driver?.displayName ?? catalog.displayName,
        installState,
        available: false,
        runnable: false,
        setupAction: "none",
        safeReason: "runtime_not_supported",
      };
    }

    if (catalogDriverRunnable(catalog, driver)) {
      return {
        harness: catalog.harness,
        displayName: driver!.displayName,
        installState,
        available: true,
        runnable: true,
        setupAction: "none",
        safeReason: null,
      };
    }

    const setupAction = driver?.setupActions[0]
      ?? (installState === "missing" ? "install" : "retry");
    return {
      harness: catalog.harness,
      displayName: driver?.displayName ?? catalog.displayName,
      installState,
      available: true,
      runnable: false,
      setupAction,
      safeReason: catalogSafeReason(driver),
    };
  });
}
