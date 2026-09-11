import { z } from "zod/v4";
import { canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";
import { IsoTimestampSchema, ProviderModelReferenceSchema } from "#contract-primitives";

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const ReferenceIdSchema = canonicalReferenceId(128);
const ProviderIdSchema = canonicalReferenceId(128);
const DisplayNameSchema = canonicalSafeLabel(120, 480);
const RevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const MicrousdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DependencyCountSchema = z.number().int().min(0).max(1_000_000);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, "Invalid currency code");
const UsageStateSchema = z.enum(["current", "stale"]);
const UsageScopeSchema = z.enum(["account", "access_source", "owner_entitlement"]);

export const ProviderHarnessKindSchema = z.enum([
  "hermes", "openclaw", "pi", "opencode", "codex", "claude",
]);
export const ProviderGenericHarnessKindSchema = z.enum([
  "hermes", "openclaw", "pi", "opencode",
]);
export const ProviderHarnessInstallStateSchema = z.enum([
  "installed", "missing", "installing", "failed", "unknown",
]);
export const ProviderAuthenticationStateSchema = z.enum([
  "authenticated", "authenticating", "unauthenticated", "expired", "failed", "unknown",
]);
export const ProviderLoginMethodSchema = z.enum(["terminal", "oauth", "api_key"]);
export const ProviderConnectivityStateSchema = z.enum([
  "online", "offline", "degraded", "unknown",
]);
export const ProviderSettingsAccessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("writable") }).strict(),
  z.object({
    mode: z.literal("read_only"),
    reason: z.enum(["remote_policy", "insufficient_permission", "runtime_unavailable"]),
  }).strict(),
]);
export const ProviderAccentColorSchema = z.enum([
  "blue", "green", "orange", "red", "purple", "cyan", "teal",
]);

export const ProviderSourceReadinessSchema = z.object({
  state: z.enum([
    "ready", "setup_required", "auth_required", "invalid", "expired",
    "unavailable", "disabled", "stale", "unknown",
  ]),
  checkedAt: IsoTimestampSchema.nullable(),
  staleAfter: IsoTimestampSchema.nullable(),
  action: z.enum(["none", "connect", "enter_api_key", "open_terminal", "retry", "contact_owner"]),
  safeReason: z.enum(["auth", "timeout", "rate_limited", "provider_unavailable", "policy", "unknown"]).nullable(),
}).strict().superRefine((readiness, ctx) => {
  if (readiness.state === "ready" && readiness.action !== "none") {
    ctx.addIssue({ code: "custom", path: ["action"], message: "Ready sources cannot require an action" });
  }
  if (readiness.state !== "ready" && readiness.action === "none") {
    ctx.addIssue({ code: "custom", path: ["action"], message: "Unavailable sources require a safe action" });
  }
  if (readiness.checkedAt === null && readiness.staleAfter !== null) {
    ctx.addIssue({ code: "custom", path: ["staleAfter"], message: "Staleness requires a checked time" });
  }
});

export const ProviderModelViewSchema = z.object({
  id: ProviderModelReferenceSchema,
  displayName: DisplayNameSchema,
  enabled: z.boolean(),
}).strict();
export const ProviderModelProviderSchema = z.object({
  id: ProviderIdSchema,
  displayName: DisplayNameSchema,
  models: z.array(ProviderModelViewSchema).max(256),
}).strict().superRefine((provider, ctx) => {
  if (!unique(provider.models.map((model) => model.id))) {
    ctx.addIssue({ code: "custom", path: ["models"], message: "Duplicate model id" });
  }
});

const RouteFields = { providerId: ProviderIdSchema, modelId: ProviderModelReferenceSchema } as const;
export const ProviderConfigurableRouteSchema = z.object({
  kind: z.literal("configurable"), ...RouteFields,
}).strict();
export const ProviderFixedRouteSchema = z.object({
  kind: z.literal("fixed"), ...RouteFields,
}).strict();
export const ProviderHarnessRouteSchema = z.discriminatedUnion("kind", [
  ProviderConfigurableRouteSchema, ProviderFixedRouteSchema,
]);

const ProviderBalanceSchema = z.object({
  authority: z.literal("provider_balance"),
  state: UsageStateSchema,
  remainingMicrousd: MicrousdSchema,
  asOf: IsoTimestampSchema,
}).strict();

export const ProviderManagedCreditSchema = z.object({
  promotionalBalanceMicrousd: MicrousdSchema,
  addonBalanceMicrousd: MicrousdSchema,
  creditBalanceMicrousd: MicrousdSchema,
  reservedMicrousd: MicrousdSchema,
  fundingShortfallMicrousd: MicrousdSchema.optional(),
  remainingBalanceMicrousd: MicrousdSchema,
}).strict().superRefine((credit, ctx) => {
  const total = credit.promotionalBalanceMicrousd + credit.addonBalanceMicrousd;
  if (!Number.isSafeInteger(total) || credit.creditBalanceMicrousd !== total) {
    ctx.addIssue({ code: "custom", path: ["creditBalanceMicrousd"], message: "Credit buckets must equal total credit" });
  }
  if (credit.remainingBalanceMicrousd !== Math.max(
    0,
    credit.creditBalanceMicrousd - credit.reservedMicrousd - (credit.fundingShortfallMicrousd ?? 0),
  )) {
    ctx.addIssue({ code: "custom", path: ["remainingBalanceMicrousd"], message: "Remaining credit is inconsistent" });
  }
});

export const ProviderManagedBudgetSchema = z.object({
  monthlyBudgetMicrousd: MicrousdSchema,
  settledThisMonthMicrousd: MicrousdSchema,
  reservedThisMonthMicrousd: MicrousdSchema,
  remainingBudgetMicrousd: MicrousdSchema,
}).strict().superRefine((budget, ctx) => {
  const committed = budget.settledThisMonthMicrousd + budget.reservedThisMonthMicrousd;
  if (!Number.isSafeInteger(committed)
    || budget.remainingBudgetMicrousd !== Math.max(0, budget.monthlyBudgetMicrousd - committed)) {
    ctx.addIssue({ code: "custom", path: ["remainingBudgetMicrousd"], message: "Remaining budget is inconsistent" });
  }
});

export const ProviderUsageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed_credit"),
    authority: z.literal("matrix_ledger"),
    state: UsageStateSchema,
    scope: z.enum(["access_source", "owner_entitlement"]),
    currency: CurrencySchema,
    usedMicrousd: MicrousdSchema,
    remainingMicrousd: MicrousdSchema,
    limitMicrousd: MicrousdSchema,
    periodStartedAt: IsoTimestampSchema,
    resetsAt: IsoTimestampSchema.nullable(),
    asOf: IsoTimestampSchema,
    credit: ProviderManagedCreditSchema,
    budget: ProviderManagedBudgetSchema,
  }).strict().superRefine((usage, ctx) => {
    if (usage.limitMicrousd !== usage.budget.monthlyBudgetMicrousd
      || usage.usedMicrousd !== usage.budget.settledThisMonthMicrousd
      || usage.remainingMicrousd !== Math.min(
        usage.credit.remainingBalanceMicrousd,
        usage.budget.remainingBudgetMicrousd,
      )) {
      ctx.addIssue({ code: "custom", path: ["budget"], message: "Managed credit summary must match spendable credit and monthly budget" });
    }
  }),
  z.object({
    kind: z.literal("metered_api"),
    authority: z.literal("matrix_observed"),
    state: UsageStateSchema,
    scope: z.literal("account"),
    currency: CurrencySchema,
    observedUsageMicrousd: MicrousdSchema,
    providerBalance: ProviderBalanceSchema.nullable(),
    periodStartedAt: IsoTimestampSchema,
    resetsAt: IsoTimestampSchema.nullable(),
    asOf: IsoTimestampSchema,
  }).strict(),
  z.object({
    kind: z.literal("subscription_allowance"),
    authority: z.literal("provider_allowance"),
    state: UsageStateSchema,
    scope: z.literal("account"),
    usedBasisPoints: z.number().int().min(0).max(10_000),
    resetsAt: IsoTimestampSchema.nullable(),
    asOf: IsoTimestampSchema,
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    authority: z.literal("unavailable"),
    state: z.enum(["unavailable", "not_applicable"]),
    scope: UsageScopeSchema,
    reason: z.enum([
      "ledger_not_available", "provider_does_not_report", "not_authenticated",
      "offline", "read_only", "unknown",
    ]),
    asOf: IsoTimestampSchema.nullable(),
  }).strict(),
]);

export const ProviderFundingKindSchema = z.enum([
  "matrix_included", "matrix_addon", "owner_account", "owner_api_key", "owner_subscription",
]);
export const ProviderAccessSourceSchema = z.object({
  id: ReferenceIdSchema,
  kind: z.enum(["matrix_gateway", "provider_account"]),
  fundingKind: ProviderFundingKindSchema,
  providerId: ProviderIdSchema,
  accountId: ReferenceIdSchema.nullable(),
  displayName: DisplayNameSchema,
  readiness: ProviderSourceReadinessSchema,
  eligibleModelIds: z.array(ProviderModelReferenceSchema).max(256),
  usage: ProviderUsageSchema,
}).strict().superRefine((source, ctx) => {
  if (!unique(source.eligibleModelIds)) {
    ctx.addIssue({ code: "custom", path: ["eligibleModelIds"], message: "Duplicate eligible model" });
  }
  const matrixFunded = source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon";
  if (source.kind === "matrix_gateway" && (!matrixFunded || source.accountId !== null)) {
    ctx.addIssue({ code: "custom", message: "Matrix gateway sources require Matrix funding and no provider account" });
  }
  if (source.kind === "provider_account" && (matrixFunded || source.accountId === null)) {
    ctx.addIssue({ code: "custom", message: "Provider account sources require owner funding and an account" });
  }
  if (source.kind === "matrix_gateway"
    && source.usage.kind !== "managed_credit" && source.usage.kind !== "unavailable") {
    ctx.addIssue({ code: "custom", path: ["usage"], message: "Matrix gateway usage must be ledger-backed or unavailable" });
  }
});

export const ProviderDependencyCountsSchema = z.object({
  activeChatCount: DependencyCountSchema,
  resumableChatCount: DependencyCountSchema,
  harnessInstanceCount: DependencyCountSchema,
}).strict();
export const ProviderAccountSchema = z.object({
  id: ReferenceIdSchema,
  providerId: ProviderIdSchema,
  displayName: DisplayNameSchema,
  authMethod: z.enum(["terminal", "oauth", "api_key"]),
  authState: ProviderAuthenticationStateSchema,
  lastCheckedAt: IsoTimestampSchema.nullable(),
  accessSourceId: ReferenceIdSchema,
  dependencies: ProviderDependencyCountsSchema,
}).strict();

export const ProviderHarnessInstanceSchema = z.object({
  id: ReferenceIdSchema,
  harness: ProviderHarnessKindSchema,
  displayName: DisplayNameSchema,
  accentColor: ProviderAccentColorSchema.nullable(),
  enabled: z.boolean(),
  version: canonicalSafeLabel(64, 256).nullable(),
  installState: ProviderHarnessInstallStateSchema,
  authState: ProviderAuthenticationStateSchema,
  loginMethods: z.array(ProviderLoginMethodSchema).max(3),
  recommendedLoginMethod: ProviderLoginMethodSchema.nullable(),
  connectivity: ProviderConnectivityStateSchema,
  accountIds: z.array(ReferenceIdSchema).max(32),
  selectedAccountId: ReferenceIdSchema.nullable(),
  accessSourceId: ReferenceIdSchema.nullable(),
  route: ProviderHarnessRouteSchema,
  activeChatCount: DependencyCountSchema,
}).strict().superRefine((harness, ctx) => {
  if (!unique(harness.accountIds) || !unique(harness.loginMethods)) {
    ctx.addIssue({ code: "custom", message: "Harness account and login method sets must be unique" });
  }
  if (harness.loginMethods.length === 0 && harness.recommendedLoginMethod !== null) {
    ctx.addIssue({ code: "custom", path: ["recommendedLoginMethod"], message: "Unavailable login cannot recommend a method" });
  }
  if (harness.loginMethods.length > 0
    && (harness.recommendedLoginMethod === null
      || !harness.loginMethods.includes(harness.recommendedLoginMethod))) {
    ctx.addIssue({ code: "custom", path: ["recommendedLoginMethod"], message: "Recommended login must be supported" });
  }
  if (harness.selectedAccountId !== null && !harness.accountIds.includes(harness.selectedAccountId)) {
    ctx.addIssue({ code: "custom", path: ["selectedAccountId"], message: "Selected account must belong to the harness" });
  }
  if (harness.installState !== "installed" && (harness.enabled || harness.version !== null)) {
    ctx.addIssue({ code: "custom", message: "Only installed harnesses can expose a version or be enabled" });
  }
});

export const ProviderHarnessSetupActionSchema = z.enum([
  "none", "install", "connect_account", "enter_api_key", "open_terminal", "retry",
]);
export const ProviderHarnessCatalogSafeReasonSchema = z.enum([
  "not_installed",
  "installing",
  "install_failed",
  "install_state_unknown",
  "runtime_not_supported",
  "runtime_unavailable",
  "setup_required",
]);
export const ProviderHarnessCatalogEntrySchema = z.object({
  harness: ProviderGenericHarnessKindSchema,
  displayName: DisplayNameSchema,
  installState: ProviderHarnessInstallStateSchema,
  /** The current runtime coordinator supports configuration for this kind. */
  available: z.boolean(),
  /** Canonical inventory says an add/enable operation can run now. */
  runnable: z.boolean(),
  setupAction: ProviderHarnessSetupActionSchema,
  safeReason: ProviderHarnessCatalogSafeReasonSchema.nullable(),
}).strict().superRefine((entry, ctx) => {
  if (entry.runnable && (!entry.available || entry.installState !== "installed"
    || entry.setupAction !== "none" || entry.safeReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Runnable harnesses must be installed, available, and setup-free" });
  }
  if (!entry.runnable && entry.safeReason === null) {
    ctx.addIssue({ code: "custom", path: ["safeReason"], message: "Unavailable harnesses require a safe reason" });
  }
  if (!entry.available && (entry.runnable || entry.setupAction !== "none"
    || entry.safeReason !== "runtime_not_supported")) {
    ctx.addIssue({ code: "custom", message: "Unsupported harnesses cannot advertise setup or execution" });
  }
  if (entry.available && !entry.runnable && entry.setupAction === "none") {
    ctx.addIssue({ code: "custom", path: ["setupAction"], message: "Supported unavailable harnesses require a setup action" });
  }
  if (entry.setupAction === "install" && entry.installState === "installed") {
    ctx.addIssue({ code: "custom", path: ["setupAction"], message: "Installed harnesses cannot require installation" });
  }
});

export const ProviderGatewayPolicySchema = z.object({
  accessSourceId: ReferenceIdSchema,
  monthlyBudgetMicrousd: MicrousdSchema.nullable(),
  allowedModelIds: z.array(ProviderModelReferenceSchema).max(256),
  topUpEnabled: z.boolean(),
}).strict().superRefine((policy, ctx) => {
  if (!unique(policy.allowedModelIds)) {
    ctx.addIssue({ code: "custom", path: ["allowedModelIds"], message: "Duplicate allowed model" });
  }
});

/**
 * Server-confirmed capabilities for the current owner/runtime. Values matching
 * mutation discriminants mean the corresponding mutation endpoint is wired;
 * reserved values stay absent until their dedicated workflows exist.
 */
export const ProviderSettingsSupportedActionSchema = z.enum([
  "add_harness",
  "remove_harness",
  "update_harness",
  "set_harness_enabled",
  "set_route",
  "select_account",
  "select_access_source",
  "start_login",
  "logout_account",
  "remove_account",
  "reassign_account",
  "set_gateway_budget",
  "set_gateway_allowlist",
  "add_credit",
  "submit_api_key",
]);

/** UI mutation projection derived from, and explicitly lineaged to, AiProviderSnapshotV3. */
export const ProviderSettingsSnapshotSchema = z.object({
  contractVersion: z.literal(1),
  projectionOf: z.object({
    contract: z.literal("AiProviderSnapshotV3"),
    contractVersion: z.literal(3),
    revision: RevisionSchema,
  }).strict(),
  revision: RevisionSchema,
  refreshedAt: IsoTimestampSchema,
  access: ProviderSettingsAccessSchema,
  supportedActions: z.array(ProviderSettingsSupportedActionSchema).max(15),
  configurationHarnessKinds: z.array(ProviderHarnessKindSchema).max(6).optional(),
  harnessCatalog: z.array(ProviderHarnessCatalogEntrySchema).length(4),
  modelProviders: z.array(ProviderModelProviderSchema).max(32),
  accessSources: z.array(ProviderAccessSourceSchema).max(64),
  accounts: z.array(ProviderAccountSchema).max(128),
  harnesses: z.array(ProviderHarnessInstanceSchema).max(128),
  gatewayPolicy: ProviderGatewayPolicySchema.nullable(),
}).strict().superRefine((snapshot, ctx) => {
  const collections = [
    ["modelProviders", snapshot.modelProviders.map((value) => value.id)],
    ["accessSources", snapshot.accessSources.map((value) => value.id)],
    ["accounts", snapshot.accounts.map((value) => value.id)],
    ["harnesses", snapshot.harnesses.map((value) => value.id)],
  ] as const;
  if (!unique(snapshot.supportedActions)) {
    ctx.addIssue({ code: "custom", path: ["supportedActions"], message: "Duplicate supported action" });
  }
  if (snapshot.configurationHarnessKinds && !unique(snapshot.configurationHarnessKinds)) {
    ctx.addIssue({ code: "custom", path: ["configurationHarnessKinds"], message: "Duplicate configurable harness kind" });
  }
  const genericHarnessKinds = ProviderGenericHarnessKindSchema.options;
  if (!unique(snapshot.harnessCatalog.map((entry) => entry.harness))
    || genericHarnessKinds.some((kind) => !snapshot.harnessCatalog.some((entry) => entry.harness === kind))) {
    ctx.addIssue({ code: "custom", path: ["harnessCatalog"], message: "Generic harness catalog must contain each supported kind exactly once" });
  }
  if (snapshot.configurationHarnessKinds) {
    const configurable = new Set(snapshot.configurationHarnessKinds);
    snapshot.harnessCatalog.forEach((entry, index) => {
      if (entry.available !== configurable.has(entry.harness)) {
        ctx.addIssue({ code: "custom", path: ["harnessCatalog", index, "available"], message: "Harness availability must match runtime configuration support" });
      }
    });
  }
  if (snapshot.access.mode === "read_only" && snapshot.supportedActions.length > 0) {
    ctx.addIssue({ code: "custom", path: ["supportedActions"], message: "Read-only settings cannot advertise mutations" });
  }
  if (snapshot.supportedActions.includes("add_credit") && snapshot.gatewayPolicy?.topUpEnabled !== true) {
    ctx.addIssue({ code: "custom", path: ["supportedActions"], message: "Credit purchase requires an enabled top-up workflow" });
  }
  if (snapshot.supportedActions.includes("submit_api_key")
    && !snapshot.harnesses.some((harness) => harness.loginMethods.includes("api_key"))) {
    ctx.addIssue({ code: "custom", path: ["supportedActions"], message: "API-key submission requires a compatible harness" });
  }
  if ((snapshot.supportedActions.includes("set_gateway_budget")
    || snapshot.supportedActions.includes("set_gateway_allowlist"))
    && snapshot.gatewayPolicy === null) {
    ctx.addIssue({ code: "custom", path: ["supportedActions"], message: "Gateway policy mutations require a gateway policy" });
  }
  for (const [key, ids] of collections) {
    if (!unique(ids)) ctx.addIssue({ code: "custom", path: [key], message: `Duplicate ${key} id` });
  }
  const providers = new Map(snapshot.modelProviders.map((value) => [value.id, value]));
  const models = new Map(snapshot.modelProviders.flatMap((provider) =>
    provider.models.map((model) => [model.id, { ...model, providerId: provider.id }] as const)));
  const sources = new Map(snapshot.accessSources.map((value) => [value.id, value]));
  const accounts = new Map(snapshot.accounts.map((value) => [value.id, value]));
  if (models.size !== snapshot.modelProviders.reduce((count, provider) => count + provider.models.length, 0)) {
    ctx.addIssue({ code: "custom", path: ["modelProviders"], message: "Model ids must be globally unique" });
  }
  snapshot.accessSources.forEach((source, index) => {
    if (!providers.has(source.providerId)) {
      ctx.addIssue({ code: "custom", path: ["accessSources", index, "providerId"], message: "Unknown model provider" });
    }
    source.eligibleModelIds.forEach((modelId, modelIndex) => {
      const model = models.get(modelId);
      if (model === undefined || model.providerId !== source.providerId) {
        ctx.addIssue({ code: "custom", path: ["accessSources", index, "eligibleModelIds", modelIndex], message: "Model is not supplied by this provider" });
      }
    });
    if (source.kind === "provider_account") {
      const account = source.accountId === null ? undefined : accounts.get(source.accountId);
      if (account === undefined || account.accessSourceId !== source.id || account.providerId !== source.providerId) {
        ctx.addIssue({ code: "custom", path: ["accessSources", index, "accountId"], message: "Provider account source must be reciprocal" });
      }
    }
  });
  snapshot.accounts.forEach((account, index) => {
    const source = sources.get(account.accessSourceId);
    if (!providers.has(account.providerId) || source?.kind !== "provider_account"
      || source.accountId !== account.id || source.providerId !== account.providerId) {
      ctx.addIssue({ code: "custom", path: ["accounts", index, "accessSourceId"], message: "Account source must be reciprocal" });
    }
  });
  snapshot.harnesses.forEach((harness, index) => {
    harness.accountIds.forEach((accountId, accountIndex) => {
      if (!accounts.has(accountId)) ctx.addIssue({ code: "custom", path: ["harnesses", index, "accountIds", accountIndex], message: "Unknown account" });
    });
    const model = models.get(harness.route.modelId);
    if (model === undefined || model.providerId !== harness.route.providerId || !model.enabled) {
      ctx.addIssue({ code: "custom", path: ["harnesses", index, "route"], message: "Route model is not enabled for this provider" });
    }
    if (harness.accessSourceId === null) {
      if (harness.selectedAccountId !== null) ctx.addIssue({ code: "custom", path: ["harnesses", index], message: "Account selection requires an access source" });
      return;
    }
    const source = sources.get(harness.accessSourceId);
    if (source === undefined || source.providerId !== harness.route.providerId
      || !source.eligibleModelIds.includes(harness.route.modelId)) {
      ctx.addIssue({ code: "custom", path: ["harnesses", index, "accessSourceId"], message: "Access source is not eligible for the route" });
      return;
    }
    if (source.kind === "matrix_gateway" && harness.selectedAccountId !== null) {
      ctx.addIssue({ code: "custom", path: ["harnesses", index, "selectedAccountId"], message: "Matrix gateway routes cannot select a provider account" });
    }
    if (source.kind === "provider_account" && harness.selectedAccountId !== source.accountId) {
      ctx.addIssue({ code: "custom", path: ["harnesses", index, "selectedAccountId"], message: "Selected account must match the provider access source" });
    }
  });
  if (snapshot.gatewayPolicy !== null) {
    const source = sources.get(snapshot.gatewayPolicy.accessSourceId);
    if (source?.kind !== "matrix_gateway") {
      ctx.addIssue({ code: "custom", path: ["gatewayPolicy", "accessSourceId"], message: "Gateway policy requires a Matrix gateway source" });
    } else {
      snapshot.gatewayPolicy.allowedModelIds.forEach((modelId, index) => {
        if (!source.eligibleModelIds.includes(modelId)) ctx.addIssue({ code: "custom", path: ["gatewayPolicy", "allowedModelIds", index], message: "Model is not gateway eligible" });
      });
      snapshot.harnesses.forEach((harness, index) => {
        if (harness.accessSourceId === source.id && !snapshot.gatewayPolicy?.allowedModelIds.includes(harness.route.modelId)) {
          ctx.addIssue({ code: "custom", path: ["harnesses", index, "route"], message: "Route model is not allowed by gateway policy" });
        }
      });
    }
  }
});

const MutationBase = { expectedRevision: RevisionSchema, idempotencyKey: ReferenceIdSchema } as const;
const ReassignmentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), accountId: ReferenceIdSchema }).strict(),
  z.object({ kind: z.literal("access_source"), accessSourceId: ReferenceIdSchema }).strict(),
]);
export const ProviderSettingsMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_harness"), ...MutationBase, harness: ProviderHarnessKindSchema,
    displayName: DisplayNameSchema, accentColor: ProviderAccentColorSchema.nullable().optional(),
    route: ProviderHarnessRouteSchema, accessSourceId: ReferenceIdSchema, accountId: ReferenceIdSchema.nullable() }).strict(),
  z.object({ type: z.literal("remove_harness"), ...MutationBase, harnessInstanceId: ReferenceIdSchema,
    confirmation: z.literal("remove_harness") }).strict(),
  z.object({ type: z.literal("update_harness"), ...MutationBase, harnessInstanceId: ReferenceIdSchema,
    displayName: DisplayNameSchema.optional(), accentColor: ProviderAccentColorSchema.nullable().optional() }).strict()
    .refine((value) => value.displayName !== undefined || value.accentColor !== undefined, { message: "Harness update requires a change" }),
  z.object({ type: z.literal("set_harness_enabled"), ...MutationBase, harnessInstanceId: ReferenceIdSchema, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("set_route"), ...MutationBase, harnessInstanceId: ReferenceIdSchema,
    route: ProviderConfigurableRouteSchema, accessSourceId: ReferenceIdSchema,
    accountId: ReferenceIdSchema.nullable() }).strict(),
  z.object({ type: z.literal("select_account"), ...MutationBase, harnessInstanceId: ReferenceIdSchema, accountId: ReferenceIdSchema }).strict(),
  z.object({ type: z.literal("select_access_source"), ...MutationBase, harnessInstanceId: ReferenceIdSchema, accessSourceId: ReferenceIdSchema }).strict(),
  z.object({ type: z.literal("start_login"), ...MutationBase, harnessInstanceId: ReferenceIdSchema,
    accountId: ReferenceIdSchema.nullable(), method: ProviderLoginMethodSchema }).strict(),
  z.object({ type: z.literal("logout_account"), ...MutationBase, accountId: ReferenceIdSchema }).strict(),
  z.object({ type: z.literal("remove_account"), ...MutationBase, accountId: ReferenceIdSchema,
    dependencyGuard: ProviderDependencyCountsSchema, confirmation: z.literal("remove_account") }).strict(),
  z.object({ type: z.literal("reassign_account"), ...MutationBase, fromAccountId: ReferenceIdSchema,
    target: ReassignmentTargetSchema, scope: z.enum(["active_chats", "resumable_chats", "harnesses", "all_dependencies"]),
    dependencyGuard: ProviderDependencyCountsSchema }).strict(),
  z.object({ type: z.literal("set_gateway_budget"), ...MutationBase, monthlyBudgetMicrousd: MicrousdSchema.nullable() }).strict(),
  z.object({ type: z.literal("set_gateway_allowlist"), ...MutationBase,
    allowedModelIds: z.array(ProviderModelReferenceSchema).max(256) }).strict().superRefine((value, ctx) => {
      if (!unique(value.allowedModelIds)) ctx.addIssue({ code: "custom", path: ["allowedModelIds"], message: "Duplicate allowed model" });
    }),
]);

export const ProviderConnectionAttemptActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open_terminal"), terminalSessionId: ReferenceIdSchema }).strict(),
  z.object({
    kind: z.literal("open_browser"),
    authorizationPath: z.string().regex(
      /^\/api\/ai\/providers\/login-attempts\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/authorize$/,
      "Invalid owner-gateway authorization path",
    ),
  }).strict(),
  z.object({ kind: z.literal("enter_api_key") }).strict(),
  z.object({ kind: z.literal("wait") }).strict(),
  z.object({ kind: z.literal("retry") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export const ProviderConnectionAttemptSchema = z.object({
  id: ReferenceIdSchema,
  harnessInstanceId: ReferenceIdSchema,
  accountId: ReferenceIdSchema.nullable(),
  method: ProviderLoginMethodSchema,
  state: z.enum(["pending", "authorized", "succeeded", "denied", "expired", "failed"]),
  action: ProviderConnectionAttemptActionSchema,
  expiresAt: IsoTimestampSchema,
  safeFailure: z.enum(["denied", "expired", "provider_unavailable", "invalid_response", "unknown"]).nullable(),
}).strict();
export const ProviderSettingsMutationResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshot: ProviderSettingsSnapshotSchema }).strict(),
  z.object({ kind: z.literal("login_attempt"), snapshot: ProviderSettingsSnapshotSchema,
    attempt: ProviderConnectionAttemptSchema }).strict(),
]);

export type ProviderHarnessKind = z.infer<typeof ProviderHarnessKindSchema>;
export type ProviderGenericHarnessKind = z.infer<typeof ProviderGenericHarnessKindSchema>;
export type ProviderHarnessInstallState = z.infer<typeof ProviderHarnessInstallStateSchema>;
export type ProviderAuthenticationState = z.infer<typeof ProviderAuthenticationStateSchema>;
export type ProviderLoginMethod = z.infer<typeof ProviderLoginMethodSchema>;
export type ProviderConnectivityState = z.infer<typeof ProviderConnectivityStateSchema>;
export type ProviderSettingsAccess = z.infer<typeof ProviderSettingsAccessSchema>;
export type ProviderSourceReadiness = z.infer<typeof ProviderSourceReadinessSchema>;
export type ProviderAccentColor = z.infer<typeof ProviderAccentColorSchema>;
export type ProviderModelView = z.infer<typeof ProviderModelViewSchema>;
export type ProviderModelProvider = z.infer<typeof ProviderModelProviderSchema>;
export type ProviderConfigurableRoute = z.infer<typeof ProviderConfigurableRouteSchema>;
export type ProviderFixedRoute = z.infer<typeof ProviderFixedRouteSchema>;
export type ProviderHarnessRoute = z.infer<typeof ProviderHarnessRouteSchema>;
export type ProviderManagedCredit = z.infer<typeof ProviderManagedCreditSchema>;
export type ProviderManagedBudget = z.infer<typeof ProviderManagedBudgetSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
export type ProviderFundingKind = z.infer<typeof ProviderFundingKindSchema>;
export type ProviderAccessSource = z.infer<typeof ProviderAccessSourceSchema>;
export type ProviderDependencyCounts = z.infer<typeof ProviderDependencyCountsSchema>;
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;
export type ProviderHarnessInstance = z.infer<typeof ProviderHarnessInstanceSchema>;
export type ProviderHarnessSetupAction = z.infer<typeof ProviderHarnessSetupActionSchema>;
export type ProviderHarnessCatalogSafeReason = z.infer<typeof ProviderHarnessCatalogSafeReasonSchema>;
export type ProviderHarnessCatalogEntry = z.infer<typeof ProviderHarnessCatalogEntrySchema>;
export type ProviderGatewayPolicy = z.infer<typeof ProviderGatewayPolicySchema>;
export type ProviderSettingsSupportedAction = z.infer<typeof ProviderSettingsSupportedActionSchema>;
/** Mutable Settings projection with explicit lineage to its canonical V3 input. */
export type ProviderSettingsSnapshot = z.infer<typeof ProviderSettingsSnapshotSchema>;
export type ProviderSettingsMutation = z.infer<typeof ProviderSettingsMutationSchema>;
export type ProviderConnectionAttempt = z.infer<typeof ProviderConnectionAttemptSchema>;
export type ProviderSettingsMutationResponse = z.infer<typeof ProviderSettingsMutationResponseSchema>;

/**
 * Returns whether a generic coding harness can receive the selected access
 * source as explicit Anthropic-compatible process credentials.
 *
 * Claude subscription/OAuth profiles are intentionally excluded: those are
 * valid for Claude Code, but they do not yield a portable API key that Pi or
 * OpenCode can consume. Keeping this predicate in the public contract lets the
 * gateway, canonical Chat catalog, and every Settings renderer share one truth.
 */
export function isPortableGenericHarnessCredentialRoute(
  harness: Pick<ProviderHarnessInstance, "harness" | "accessSourceId" | "route">,
  source: Pick<
    ProviderAccessSource,
    "id" | "kind" | "fundingKind" | "providerId" | "accountId"
  > | null | undefined,
): boolean {
  if ((harness.harness !== "pi" && harness.harness !== "opencode")
    || harness.route.kind !== "configurable"
    || harness.route.providerId !== "anthropic"
    || harness.accessSourceId === null
    || source === null
    || source === undefined
    || source.id !== harness.accessSourceId
    || source.providerId !== "anthropic") {
    return false;
  }
  if (source.kind === "matrix_gateway") {
    return source.id === "matrix_included"
      && source.accountId === null
      && (source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon");
  }
  return source.kind === "provider_account"
    && source.id === "owner_anthropic_key"
    && source.accountId !== null
    && source.fundingKind === "owner_api_key";
}
