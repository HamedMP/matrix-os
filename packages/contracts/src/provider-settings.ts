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
const MoneyCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ActiveChatCountSchema = z.number().int().min(0).max(1_000_000);

export const ProviderHarnessKindSchema = z.enum([
  "hermes",
  "openclaw",
  "pi",
  "opencode",
  "codex",
  "claude",
]);

export const ProviderHarnessInstallStateSchema = z.enum([
  "installed",
  "missing",
  "installing",
  "failed",
  "unknown",
]);

export const ProviderAuthenticationStateSchema = z.enum([
  "authenticated",
  "authenticating",
  "unauthenticated",
  "expired",
  "failed",
  "unknown",
]);

export const ProviderLoginMethodSchema = z.enum(["terminal", "oauth", "api_key"]);

export const ProviderConnectivityStateSchema = z.enum([
  "online",
  "offline",
  "degraded",
  "unknown",
]);

export const ProviderSettingsAccessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("writable") }).strict(),
  z.object({
    mode: z.literal("read_only"),
    reason: z.enum(["remote_policy", "insufficient_permission", "runtime_unavailable"]),
  }).strict(),
]);

export const ProviderAccentColorSchema = z.enum([
  "blue",
  "green",
  "orange",
  "red",
  "purple",
  "cyan",
  "teal",
]);

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

const RouteFields = {
  providerId: ProviderIdSchema,
  modelId: ProviderModelReferenceSchema,
} as const;

export const ProviderConfigurableRouteSchema = z.object({
  kind: z.literal("configurable"),
  ...RouteFields,
}).strict();

export const ProviderFixedRouteSchema = z.object({
  kind: z.literal("fixed"),
  ...RouteFields,
}).strict();

export const ProviderHarnessRouteSchema = z.discriminatedUnion("kind", [
  ProviderConfigurableRouteSchema,
  ProviderFixedRouteSchema,
]);

export const ProviderUsageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed_credit"),
    currency: z.string().regex(/^[A-Z]{3}$/, "Invalid currency code"),
    usedCents: MoneyCentsSchema,
    remainingCents: MoneyCentsSchema,
    limitCents: MoneyCentsSchema,
    periodStartedAt: IsoTimestampSchema,
    resetsAt: IsoTimestampSchema.nullable(),
  }).strict().superRefine((usage, ctx) => {
    if (usage.usedCents + usage.remainingCents !== usage.limitCents) {
      ctx.addIssue({
        code: "custom",
        path: ["remainingCents"],
        message: "Managed credit must reconcile to its limit",
      });
    }
  }),
  z.object({
    kind: z.literal("metered_api"),
    currency: z.string().regex(/^[A-Z]{3}$/, "Invalid currency code"),
    observedUsageCents: MoneyCentsSchema,
    providerBalanceCents: MoneyCentsSchema.nullable(),
    periodStartedAt: IsoTimestampSchema,
    resetsAt: IsoTimestampSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("subscription_allowance"),
    usedBasisPoints: z.number().int().min(0).max(10_000),
    resetsAt: IsoTimestampSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "provider_does_not_report",
      "not_authenticated",
      "offline",
      "read_only",
      "unknown",
    ]),
  }).strict(),
]);

export const ProviderAccessSourceSchema = z.object({
  id: ReferenceIdSchema,
  kind: z.enum(["matrix_gateway", "provider_account"]),
  providerId: ProviderIdSchema,
  accountId: ReferenceIdSchema.nullable(),
  displayName: DisplayNameSchema,
  eligibleModelIds: z.array(ProviderModelReferenceSchema).max(256),
  usage: ProviderUsageSchema,
}).strict().superRefine((source, ctx) => {
  if (!unique(source.eligibleModelIds)) {
    ctx.addIssue({ code: "custom", path: ["eligibleModelIds"], message: "Duplicate eligible model" });
  }
  if (source.kind === "matrix_gateway" && source.accountId !== null) {
    ctx.addIssue({ code: "custom", path: ["accountId"], message: "Managed gateway sources do not expose provider accounts" });
  }
  if (source.kind === "provider_account" && source.accountId === null) {
    ctx.addIssue({ code: "custom", path: ["accountId"], message: "Provider account sources require an account reference" });
  }
  if (source.kind === "matrix_gateway" && source.usage.kind !== "managed_credit") {
    ctx.addIssue({ code: "custom", path: ["usage"], message: "Managed gateway usage must expose exact managed credit" });
  }
});

export const ProviderAccountSchema = z.object({
  id: ReferenceIdSchema,
  providerId: ProviderIdSchema,
  displayName: DisplayNameSchema,
  authMethod: z.enum(["managed", "terminal", "oauth", "api_key"]),
  authState: ProviderAuthenticationStateSchema,
  lastCheckedAt: IsoTimestampSchema.nullable(),
  accessSourceId: ReferenceIdSchema,
  activeChatCount: ActiveChatCountSchema,
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
  loginMethods: z.array(ProviderLoginMethodSchema).min(1).max(3),
  recommendedLoginMethod: ProviderLoginMethodSchema,
  connectivity: ProviderConnectivityStateSchema,
  accountIds: z.array(ReferenceIdSchema).max(32),
  selectedAccountId: ReferenceIdSchema.nullable(),
  accessSourceId: ReferenceIdSchema.nullable(),
  route: ProviderHarnessRouteSchema,
  activeChatCount: ActiveChatCountSchema,
}).strict().superRefine((harness, ctx) => {
  if (!unique(harness.accountIds)) {
    ctx.addIssue({ code: "custom", path: ["accountIds"], message: "Duplicate account id" });
  }
  if (!unique(harness.loginMethods)) {
    ctx.addIssue({ code: "custom", path: ["loginMethods"], message: "Duplicate login method" });
  }
  if (!harness.loginMethods.includes(harness.recommendedLoginMethod)) {
    ctx.addIssue({ code: "custom", path: ["recommendedLoginMethod"], message: "Recommended login must be supported" });
  }
  if (harness.selectedAccountId !== null && !harness.accountIds.includes(harness.selectedAccountId)) {
    ctx.addIssue({ code: "custom", path: ["selectedAccountId"], message: "Selected account must belong to the harness" });
  }
  if (harness.installState !== "installed" && harness.enabled) {
    ctx.addIssue({ code: "custom", path: ["enabled"], message: "Only installed harnesses can be enabled" });
  }
  if (harness.installState !== "installed" && harness.version !== null) {
    ctx.addIssue({ code: "custom", path: ["version"], message: "Only installed harnesses expose a version" });
  }
});

export const ProviderGatewayPolicySchema = z.object({
  accessSourceId: ReferenceIdSchema,
  monthlyBudgetCents: MoneyCentsSchema.nullable(),
  allowedModelIds: z.array(ProviderModelReferenceSchema).max(256),
  topUpEnabled: z.boolean(),
}).strict().superRefine((policy, ctx) => {
  if (!unique(policy.allowedModelIds)) {
    ctx.addIssue({ code: "custom", path: ["allowedModelIds"], message: "Duplicate allowed model" });
  }
});

export const ProviderSettingsSnapshotSchema = z.object({
  contractVersion: z.literal(1),
  revision: RevisionSchema,
  refreshedAt: IsoTimestampSchema,
  access: ProviderSettingsAccessSchema,
  modelProviders: z.array(ProviderModelProviderSchema).max(32),
  accessSources: z.array(ProviderAccessSourceSchema).max(64),
  accounts: z.array(ProviderAccountSchema).max(128),
  harnesses: z.array(ProviderHarnessInstanceSchema).max(128),
  gatewayPolicy: ProviderGatewayPolicySchema.nullable(),
}).strict().superRefine((snapshot, ctx) => {
  const collections = [
    ["modelProviders", snapshot.modelProviders.map((provider) => provider.id)],
    ["accessSources", snapshot.accessSources.map((source) => source.id)],
    ["accounts", snapshot.accounts.map((account) => account.id)],
    ["harnesses", snapshot.harnesses.map((harness) => harness.id)],
  ] as const;
  for (const [key, ids] of collections) {
    if (!unique(ids)) {
      ctx.addIssue({ code: "custom", path: [key], message: `Duplicate ${key} id` });
    }
  }

  const providers = new Map(snapshot.modelProviders.map((provider) => [provider.id, provider]));
  const models = new Map(snapshot.modelProviders.flatMap((provider) =>
    provider.models.map((model) => [model.id, { ...model, providerId: provider.id }] as const)));
  const sources = new Map(snapshot.accessSources.map((source) => [source.id, source]));
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));

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
    if (source.accountId !== null && !accounts.has(source.accountId)) {
      ctx.addIssue({ code: "custom", path: ["accessSources", index, "accountId"], message: "Unknown provider account" });
    }
  });

  snapshot.accounts.forEach((account, index) => {
    if (!providers.has(account.providerId)) {
      ctx.addIssue({ code: "custom", path: ["accounts", index, "providerId"], message: "Unknown model provider" });
    }
    const source = sources.get(account.accessSourceId);
    if (source === undefined || source.providerId !== account.providerId) {
      ctx.addIssue({ code: "custom", path: ["accounts", index, "accessSourceId"], message: "Account access source is unavailable" });
    }
  });

  snapshot.harnesses.forEach((harness, index) => {
    harness.accountIds.forEach((accountId, accountIndex) => {
      if (!accounts.has(accountId)) {
        ctx.addIssue({ code: "custom", path: ["harnesses", index, "accountIds", accountIndex], message: "Unknown account" });
      }
    });
    const routeModel = models.get(harness.route.modelId);
    if (routeModel === undefined || routeModel.providerId !== harness.route.providerId) {
      ctx.addIssue({ code: "custom", path: ["harnesses", index, "route"], message: "Route model is unavailable from this provider" });
    }
    if (harness.accessSourceId !== null) {
      const source = sources.get(harness.accessSourceId);
      if (source === undefined || source.providerId !== harness.route.providerId
        || !source.eligibleModelIds.includes(harness.route.modelId)) {
        ctx.addIssue({ code: "custom", path: ["harnesses", index, "accessSourceId"], message: "Access source is not eligible for the route" });
      }
    }
  });

  if (snapshot.gatewayPolicy !== null) {
    const source = sources.get(snapshot.gatewayPolicy.accessSourceId);
    if (source === undefined || source.kind !== "matrix_gateway") {
      ctx.addIssue({ code: "custom", path: ["gatewayPolicy", "accessSourceId"], message: "Gateway policy requires a managed gateway source" });
    } else {
      snapshot.gatewayPolicy.allowedModelIds.forEach((modelId, index) => {
        if (!source.eligibleModelIds.includes(modelId)) {
          ctx.addIssue({ code: "custom", path: ["gatewayPolicy", "allowedModelIds", index], message: "Model is not eligible for this gateway" });
        }
      });
    }
  }
});

const MutationBase = {
  expectedRevision: RevisionSchema,
} as const;

export const ProviderSettingsMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_harness"),
    ...MutationBase,
    harness: ProviderHarnessKindSchema,
    displayName: DisplayNameSchema,
    accentColor: ProviderAccentColorSchema.nullable().optional(),
    accountId: ReferenceIdSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("update_harness"),
    ...MutationBase,
    harnessInstanceId: ReferenceIdSchema,
    displayName: DisplayNameSchema.optional(),
    accentColor: ProviderAccentColorSchema.nullable().optional(),
  }).strict().refine((mutation) => mutation.displayName !== undefined || mutation.accentColor !== undefined, {
    message: "Harness update requires at least one change",
  }),
  z.object({
    type: z.literal("set_harness_enabled"),
    ...MutationBase,
    harnessInstanceId: ReferenceIdSchema,
    enabled: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("set_route"),
    ...MutationBase,
    harnessInstanceId: ReferenceIdSchema,
    route: ProviderConfigurableRouteSchema,
  }).strict(),
  z.object({
    type: z.literal("select_account"),
    ...MutationBase,
    harnessInstanceId: ReferenceIdSchema,
    accountId: ReferenceIdSchema,
  }).strict(),
  z.object({
    type: z.literal("start_login"),
    ...MutationBase,
    harnessInstanceId: ReferenceIdSchema,
    accountId: ReferenceIdSchema.nullable(),
    method: ProviderLoginMethodSchema,
  }).strict(),
  z.object({
    type: z.literal("logout_account"),
    ...MutationBase,
    accountId: ReferenceIdSchema,
  }).strict(),
  z.object({
    type: z.literal("remove_account"),
    ...MutationBase,
    accountId: ReferenceIdSchema,
  }).strict(),
  z.object({
    type: z.literal("reassign_account"),
    ...MutationBase,
    fromAccountId: ReferenceIdSchema,
    toAccountId: ReferenceIdSchema,
    scope: z.enum(["active_chats", "harnesses", "all_dependencies"]),
  }).strict().refine((mutation) => mutation.fromAccountId !== mutation.toAccountId, {
    message: "Account reassignment endpoints must differ",
  }),
  z.object({
    type: z.literal("set_gateway_budget"),
    ...MutationBase,
    monthlyBudgetCents: MoneyCentsSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("set_gateway_allowlist"),
    ...MutationBase,
    allowedModelIds: z.array(ProviderModelReferenceSchema).max(256),
  }).strict().superRefine((mutation, ctx) => {
    if (!unique(mutation.allowedModelIds)) {
      ctx.addIssue({ code: "custom", path: ["allowedModelIds"], message: "Duplicate allowed model" });
    }
  }),
]);

export const ProviderSettingsMutationResponseSchema = z.object({
  snapshot: ProviderSettingsSnapshotSchema,
}).strict();

export type ProviderHarnessKind = z.infer<typeof ProviderHarnessKindSchema>;
export type ProviderHarnessInstallState = z.infer<typeof ProviderHarnessInstallStateSchema>;
export type ProviderAuthenticationState = z.infer<typeof ProviderAuthenticationStateSchema>;
export type ProviderLoginMethod = z.infer<typeof ProviderLoginMethodSchema>;
export type ProviderConnectivityState = z.infer<typeof ProviderConnectivityStateSchema>;
export type ProviderSettingsAccess = z.infer<typeof ProviderSettingsAccessSchema>;
export type ProviderAccentColor = z.infer<typeof ProviderAccentColorSchema>;
export type ProviderModelView = z.infer<typeof ProviderModelViewSchema>;
export type ProviderModelProvider = z.infer<typeof ProviderModelProviderSchema>;
export type ProviderConfigurableRoute = z.infer<typeof ProviderConfigurableRouteSchema>;
export type ProviderFixedRoute = z.infer<typeof ProviderFixedRouteSchema>;
export type ProviderHarnessRoute = z.infer<typeof ProviderHarnessRouteSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
export type ProviderAccessSource = z.infer<typeof ProviderAccessSourceSchema>;
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;
export type ProviderHarnessInstance = z.infer<typeof ProviderHarnessInstanceSchema>;
export type ProviderGatewayPolicy = z.infer<typeof ProviderGatewayPolicySchema>;
export type ProviderSettingsSnapshot = z.infer<typeof ProviderSettingsSnapshotSchema>;
export type ProviderSettingsMutation = z.infer<typeof ProviderSettingsMutationSchema>;
export type ProviderSettingsMutationResponse = z.infer<typeof ProviderSettingsMutationResponseSchema>;
