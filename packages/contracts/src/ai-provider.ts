import { z } from "zod/v4";
import { canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";
import { IsoTimestampSchema, ProviderModelReferenceSchema } from "#contract-primitives";

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const AiProviderIdSchema = canonicalReferenceId(128);
const AiPolicyVersionSchema = canonicalReferenceId(160);
const NullableTimestampSchema = IsoTimestampSchema.nullable();

export const AiProviderVendorSchema = z.enum([
  "anthropic",
  "openrouter",
  "openai",
  "baseten",
]);

export const AiProviderReadinessStateSchema = z.enum([
  "ready",
  "setup_required",
  "auth_required",
  "invalid",
  "expired",
  "unavailable",
  "disabled",
  "stale",
  "unknown",
]);

export const AiProviderActionSchema = z.enum([
  "none",
  "connect",
  "enter_api_key",
  "open_terminal",
  "retry",
  "contact_owner",
]);

export const AiProviderSafeReasonSchema = z.enum([
  "auth",
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "policy",
  "unknown",
]);

export const AiProviderReadinessSchema = z.object({
  state: AiProviderReadinessStateSchema,
  checkedAt: NullableTimestampSchema,
  staleAfter: NullableTimestampSchema,
  action: AiProviderActionSchema,
  safeReason: AiProviderSafeReasonSchema.nullable(),
}).strict().superRefine((readiness, ctx) => {
  if (readiness.state === "ready" && readiness.action !== "none") {
    ctx.addIssue({ code: "custom", path: ["action"], message: "Ready providers cannot require setup" });
  }
  if (readiness.state !== "ready" && readiness.action === "none") {
    ctx.addIssue({ code: "custom", path: ["action"], message: "Unavailable providers require an action" });
  }
  if (readiness.checkedAt === null && readiness.staleAfter !== null) {
    ctx.addIssue({ code: "custom", path: ["staleAfter"], message: "Staleness requires a checked time" });
  }
});

export const AiAccessSourceViewSchema = AiProviderReadinessSchema.extend({
  id: AiProviderIdSchema,
  displayName: canonicalSafeLabel(120, 480),
  fundingKind: z.enum(["matrix_included", "owner_account", "owner_api_key", "matrix_addon"]),
  vendor: AiProviderVendorSchema,
  accountLabel: canonicalSafeLabel(120, 480).nullable(),
  eligibleModelIds: z.array(ProviderModelReferenceSchema).max(64),
  policyVersion: AiPolicyVersionSchema,
}).strict().superRefine((source, ctx) => {
  if (!unique(source.eligibleModelIds)) {
    ctx.addIssue({ code: "custom", path: ["eligibleModelIds"], message: "Duplicate eligible model" });
  }
  if (source.fundingKind === "matrix_included" && source.accountLabel === null) {
    ctx.addIssue({ code: "custom", path: ["accountLabel"], message: "Included access requires a label" });
  }
});

export const AiProviderAccountViewSchema = AiProviderReadinessSchema.extend({
  id: AiProviderIdSchema,
  vendor: AiProviderVendorSchema,
  authMethod: z.enum(["provider_profile", "api_key", "oauth_pkce"]).nullable(),
  accountLabel: canonicalSafeLabel(120, 480).nullable(),
}).strict().superRefine((account, ctx) => {
  if (account.state === "setup_required" && account.authMethod !== null) {
    ctx.addIssue({ code: "custom", path: ["authMethod"], message: "Unconfigured accounts cannot claim authentication" });
  }
  if (account.state === "ready" && account.authMethod === null) {
    ctx.addIssue({ code: "custom", path: ["authMethod"], message: "Ready accounts require an authentication method" });
  }
});

export const AiProviderDriverCapabilitySchema = z.enum([
  "tools",
  "resume",
  "subagents",
  "vision",
  "audio",
  "reasoning",
  "cancellation",
  "project_context",
]);

export const AiProviderDriverViewSchema = z.object({
  id: AiProviderIdSchema,
  displayName: canonicalSafeLabel(120, 480),
  kind: z.enum(["agent_sdk", "cli", "acp", "openai_compatible"]),
  installState: z.enum(["installed", "missing", "installing", "failed", "unknown"]),
  health: z.enum(["ready", "degraded", "stopped", "unavailable", "unknown"]),
  capabilities: z.array(AiProviderDriverCapabilitySchema).max(16),
  setupActions: z.array(z.enum([
    "install",
    "connect_account",
    "enter_api_key",
    "open_terminal",
    "retry",
  ])).max(8),
}).strict().superRefine((driver, ctx) => {
  if (!unique(driver.capabilities)) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "Duplicate driver capability" });
  }
  if (!unique(driver.setupActions)) {
    ctx.addIssue({ code: "custom", path: ["setupActions"], message: "Duplicate setup action" });
  }
});

export const AiModelDescriptorViewSchema = z.object({
  id: ProviderModelReferenceSchema,
  vendor: AiProviderVendorSchema,
  displayName: canonicalSafeLabel(120, 480),
  status: z.enum(["current", "legacy", "preview", "retired", "unavailable"]),
  capabilities: z.array(z.enum([
    "tools",
    "vision",
    "audio",
    "reasoning",
    "long_context",
  ])).max(16),
  effortControls: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).max(5),
  eligibleAccessSourceIds: z.array(AiProviderIdSchema).max(16),
  dataPolicies: z.array(z.object({
    accessSourceId: AiProviderIdSchema,
    route: z.enum(["matrix_relay", "owner_direct", "provider_router"]),
    disclosureKey: canonicalReferenceId(120),
  }).strict()).max(16),
  aliases: z.array(ProviderModelReferenceSchema).max(16),
  catalogVersion: AiPolicyVersionSchema,
}).strict().superRefine((model, ctx) => {
  for (const key of ["capabilities", "effortControls", "eligibleAccessSourceIds", "aliases"] as const) {
    if (!unique(model[key])) {
      ctx.addIssue({ code: "custom", path: [key], message: `Duplicate ${key} value` });
    }
  }
  if (model.aliases.includes(model.id)) {
    ctx.addIssue({ code: "custom", path: ["aliases"], message: "A model cannot alias itself" });
  }
  const policySourceIds = model.dataPolicies.map((policy) => policy.accessSourceId);
  if (!unique(policySourceIds)) {
    ctx.addIssue({ code: "custom", path: ["dataPolicies"], message: "Duplicate access source policy" });
  }
  if (policySourceIds.length !== model.eligibleAccessSourceIds.length
    || policySourceIds.some((sourceId) => !model.eligibleAccessSourceIds.includes(sourceId))) {
    ctx.addIssue({
      code: "custom",
      path: ["dataPolicies"],
      message: "Every eligible access source requires one data policy",
    });
  }
});

export const AiProviderInstanceViewSchema = z.object({
  id: AiProviderIdSchema,
  driverId: AiProviderIdSchema,
  vendor: AiProviderVendorSchema,
  accountId: AiProviderIdSchema.nullable(),
  accessSourceId: AiProviderIdSchema,
  label: canonicalSafeLabel(160, 640),
  readiness: AiProviderReadinessSchema,
  capabilitySnapshot: z.array(AiProviderDriverCapabilitySchema).max(16),
  modelIds: z.array(ProviderModelReferenceSchema).max(64),
  defaultModelId: ProviderModelReferenceSchema.nullable(),
  catalogVersion: AiPolicyVersionSchema,
}).strict().superRefine((instance, ctx) => {
  if (!unique(instance.capabilitySnapshot)) {
    ctx.addIssue({ code: "custom", path: ["capabilitySnapshot"], message: "Duplicate instance capability" });
  }
  if (!unique(instance.modelIds)) {
    ctx.addIssue({ code: "custom", path: ["modelIds"], message: "Duplicate instance model" });
  }
  if (instance.defaultModelId !== null && !instance.modelIds.includes(instance.defaultModelId)) {
    ctx.addIssue({ code: "custom", path: ["defaultModelId"], message: "Default model is not available on the instance" });
  }
  if (instance.readiness.state !== "ready" && instance.defaultModelId !== null) {
    ctx.addIssue({ code: "custom", path: ["defaultModelId"], message: "Unavailable instances cannot have a default model" });
  }
});

export const AiProviderSnapshotV3Schema = z.object({
  contractVersion: z.literal(3),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  refreshedAt: IsoTimestampSchema,
  accessSources: z.array(AiAccessSourceViewSchema).max(16),
  accounts: z.array(AiProviderAccountViewSchema).max(16),
  drivers: z.array(AiProviderDriverViewSchema).max(20),
  instances: z.array(AiProviderInstanceViewSchema).max(64),
  models: z.array(AiModelDescriptorViewSchema).max(128),
  active: z.object({
    providerInstanceId: AiProviderIdSchema.nullable(),
    accessSourceId: AiProviderIdSchema.nullable(),
    modelId: ProviderModelReferenceSchema.nullable(),
  }).strict(),
}).strict().superRefine((snapshot, ctx) => {
  const collections = [
    ["accessSources", snapshot.accessSources.map((value) => value.id)],
    ["accounts", snapshot.accounts.map((value) => value.id)],
    ["drivers", snapshot.drivers.map((value) => value.id)],
    ["instances", snapshot.instances.map((value) => value.id)],
    ["models", snapshot.models.map((value) => value.id)],
  ] as const;
  for (const [key, ids] of collections) {
    if (!unique(ids)) {
      ctx.addIssue({ code: "custom", path: [key], message: `Duplicate ${key} id` });
    }
  }

  const sources = new Map(snapshot.accessSources.map((value) => [value.id, value]));
  const accounts = new Map(snapshot.accounts.map((value) => [value.id, value]));
  const drivers = new Map(snapshot.drivers.map((value) => [value.id, value]));
  const models = new Map(snapshot.models.map((value) => [value.id, value]));
  const instances = new Map(snapshot.instances.map((value) => [value.id, value]));

  snapshot.models.forEach((model, index) => {
    model.eligibleAccessSourceIds.forEach((sourceId, sourceIndex) => {
      if (!sources.has(sourceId)) {
        ctx.addIssue({ code: "custom", path: ["models", index, "eligibleAccessSourceIds", sourceIndex], message: "Unknown access source" });
      }
    });
    model.dataPolicies.forEach((policy, policyIndex) => {
      if (!sources.has(policy.accessSourceId)) {
        ctx.addIssue({ code: "custom", path: ["models", index, "dataPolicies", policyIndex, "accessSourceId"], message: "Unknown access source" });
      }
    });
  });

  snapshot.instances.forEach((instance, index) => {
    const source = sources.get(instance.accessSourceId);
    if (!drivers.has(instance.driverId)) {
      ctx.addIssue({ code: "custom", path: ["instances", index, "driverId"], message: "Unknown provider driver" });
    }
    if (source === undefined || source.vendor !== instance.vendor) {
      ctx.addIssue({ code: "custom", path: ["instances", index, "accessSourceId"], message: "Unknown or incompatible access source" });
    }
    if (instance.accountId !== null) {
      const account = accounts.get(instance.accountId);
      if (account === undefined || account.vendor !== instance.vendor) {
        ctx.addIssue({ code: "custom", path: ["instances", index, "accountId"], message: "Unknown or incompatible provider account" });
      }
    }
    instance.modelIds.forEach((modelId, modelIndex) => {
      const model = models.get(modelId);
      if (model === undefined
        || model.vendor !== instance.vendor
        || !source?.eligibleModelIds.includes(modelId)
        || !model.eligibleAccessSourceIds.includes(instance.accessSourceId)) {
        ctx.addIssue({ code: "custom", path: ["instances", index, "modelIds", modelIndex], message: "Model is not eligible for this instance" });
      }
    });
  });

  const activeValues = Object.values(snapshot.active);
  const hasActive = activeValues.some((value) => value !== null);
  if (hasActive && activeValues.some((value) => value === null)) {
    ctx.addIssue({ code: "custom", path: ["active"], message: "Active selection must be complete" });
    return;
  }
  if (!hasActive) return;
  const instance = instances.get(snapshot.active.providerInstanceId!);
  if (instance === undefined
    || instance.readiness.state !== "ready"
    || instance.accessSourceId !== snapshot.active.accessSourceId
    || !instance.modelIds.includes(snapshot.active.modelId!)) {
    ctx.addIssue({ code: "custom", path: ["active"], message: "Active selection is not runnable" });
  }
});

export type AiProviderVendor = z.infer<typeof AiProviderVendorSchema>;
export type AiProviderReadinessState = z.infer<typeof AiProviderReadinessStateSchema>;
export type AiProviderReadiness = z.infer<typeof AiProviderReadinessSchema>;
export type AiAccessSourceView = z.infer<typeof AiAccessSourceViewSchema>;
export type AiProviderAccountView = z.infer<typeof AiProviderAccountViewSchema>;
export type AiProviderDriverCapability = z.infer<typeof AiProviderDriverCapabilitySchema>;
export type AiProviderDriverView = z.infer<typeof AiProviderDriverViewSchema>;
export type AiProviderInstanceView = z.infer<typeof AiProviderInstanceViewSchema>;
export type AiModelDescriptorView = z.infer<typeof AiModelDescriptorViewSchema>;
export type AiProviderSnapshotV3 = z.infer<typeof AiProviderSnapshotV3Schema>;
