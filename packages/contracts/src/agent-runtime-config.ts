import { z } from "zod/v4";

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const SafeSlugSchema = z.string().min(1).max(80).regex(SAFE_SLUG);
const SafeLabelSchema = z.string().trim().min(1).max(120);
const ModelReferenceSchema = z.string().trim().min(1).max(160);
const IsoTimestampSchema = z.string().regex(ISO_DATETIME);

export const AgentRuntimeIdSchema = z.enum(["hermes", "openclaw"]);
export const AgentEffortSchema = z.enum(["low", "medium", "high", "max"]);
export const AgentAuthKindSchema = z.enum([
  "platform",
  "api_key",
  "oauth_login",
  "base_url",
]);
export const AgentAuthStateSchema = z.enum([
  "ready",
  "action_required",
  "unavailable",
  "unknown",
]);
export const AgentAuthActionSchema = z.enum([
  "none",
  "enter_api_key",
  "open_login_terminal",
  "configure_base_url",
  "contact_owner",
]);

export const AgentProviderAuthStatusSchema = z.object({
  state: AgentAuthStateSchema,
  authenticated: z.boolean(),
  action: AgentAuthActionSchema.optional(),
  lastCheckedAt: IsoTimestampSchema.optional(),
}).strict().superRefine((status, ctx) => {
  if (status.authenticated !== (status.state === "ready")) {
    ctx.addIssue({
      code: "custom",
      path: ["authenticated"],
      message: "Authenticated status must agree with readiness",
    });
  }
});

export const AgentModelCapabilitySchema = z.enum([
  "tools",
  "vision",
  "reasoning",
  "audio",
  "long_context",
]);

export const AgentModelDescriptorSchema = z.object({
  id: ModelReferenceSchema,
  displayName: SafeLabelSchema,
  description: z.string().trim().min(1).max(240).optional(),
  capabilities: z.array(AgentModelCapabilitySchema).max(12),
  efforts: z.array(AgentEffortSchema).max(4),
  available: z.boolean(),
}).strict().superRefine((model, ctx) => {
  if (new Set(model.capabilities).size !== model.capabilities.length) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "Duplicate capability" });
  }
  if (new Set(model.efforts).size !== model.efforts.length) {
    ctx.addIssue({ code: "custom", path: ["efforts"], message: "Duplicate effort" });
  }
});

export const AgentProviderScopeSchema = z.enum(["chat", "messaging"]);
export const AgentProviderDescriptorSchema = z.object({
  id: SafeSlugSchema,
  displayName: SafeLabelSchema,
  runtime: AgentRuntimeIdSchema.nullable(),
  scopes: z.array(AgentProviderScopeSchema).min(1).max(2),
  authKind: AgentAuthKindSchema,
  supportedAuthKinds: z.array(AgentAuthKindSchema).min(1).max(4),
  models: z.array(AgentModelDescriptorSchema).max(128),
  authStatus: AgentProviderAuthStatusSchema,
}).strict().superRefine((provider, ctx) => {
  if (new Set(provider.scopes).size !== provider.scopes.length) {
    ctx.addIssue({ code: "custom", path: ["scopes"], message: "Duplicate provider scope" });
  }
  if (new Set(provider.supportedAuthKinds).size !== provider.supportedAuthKinds.length) {
    ctx.addIssue({ code: "custom", path: ["supportedAuthKinds"], message: "Duplicate auth kind" });
  }
  if (!provider.supportedAuthKinds.includes(provider.authKind)) {
    ctx.addIssue({
      code: "custom",
      path: ["authKind"],
      message: "Effective auth kind must be supported",
    });
  }
  if (new Set(provider.models.map((model) => model.id)).size !== provider.models.length) {
    ctx.addIssue({ code: "custom", path: ["models"], message: "Duplicate model id" });
  }
});

export const AgentProviderCatalogSchema = z.array(AgentProviderDescriptorSchema)
  .max(32)
  .superRefine((providers, ctx) => {
    const keys = providers.map((provider) => `${provider.runtime ?? "kernel"}:${provider.id}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate provider id in runtime scope" });
    }
    const modelCount = providers.reduce((total, provider) => total + provider.models.length, 0);
    if (modelCount > 256) {
      ctx.addIssue({ code: "custom", message: "Provider model catalog exceeds cap" });
    }
  });

export const AgentRuntimeInstallStateSchema = z.enum([
  "installed",
  "missing",
  "installing",
  "failed",
  "unknown",
]);
export const AgentRuntimeHealthSchema = z.enum([
  "healthy",
  "degraded",
  "stopped",
  "unreachable",
  "unknown",
]);
export const AgentRuntimeSelectionStateSchema = z.enum([
  "active",
  "available",
  "action_required",
  "unavailable",
]);
export const AgentRuntimeCapabilitySchema = z.enum([
  "provider_catalog",
  "model_selection",
  "authentication",
  "messaging_dashboard",
  "install",
]);
export const AgentRuntimeSetupActionSchema = z.enum(["install", "open_setup_terminal"]);

export const AgentRuntimeDescriptorSchema = z.object({
  id: AgentRuntimeIdSchema,
  displayName: z.string().trim().min(1).max(80),
  installState: AgentRuntimeInstallStateSchema,
  health: AgentRuntimeHealthSchema,
  selectionState: AgentRuntimeSelectionStateSchema,
  configured: z.boolean(),
  version: z.string().trim().min(1).max(64).optional(),
  capabilities: z.array(AgentRuntimeCapabilitySchema).max(16),
  setupAction: AgentRuntimeSetupActionSchema.optional(),
}).strict().superRefine((runtime, ctx) => {
  if (new Set(runtime.capabilities).size !== runtime.capabilities.length) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "Duplicate capability" });
  }
});

export const AgentRuntimeTransitionStateSchema = z.enum([
  "validating",
  "pausing",
  "draining",
  "activating",
  "verifying",
  "committing",
  "rolling_back",
]);
export const AgentRuntimeTransitionSchema = z.object({
  from: AgentRuntimeIdSchema,
  to: AgentRuntimeIdSchema,
  state: AgentRuntimeTransitionStateSchema,
}).strict().refine((transition) => transition.from !== transition.to, {
  message: "Runtime transition endpoints must differ",
});

export const AgentRuntimeSelectionSchema = z.object({
  selected: AgentRuntimeIdSchema,
  options: z.array(AgentRuntimeDescriptorSchema).length(2),
  transition: AgentRuntimeTransitionSchema.nullable(),
}).strict().superRefine((selection, ctx) => {
  const ids = selection.options.map((runtime) => runtime.id);
  if (new Set(ids).size !== 2 || !ids.includes("hermes") || !ids.includes("openclaw")) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Both runtimes are required" });
  }
  const active = selection.options.filter((runtime) => runtime.selectionState === "active");
  if (active.length !== 1 || active[0]?.id !== selection.selected) {
    ctx.addIssue({
      code: "custom",
      path: ["selected"],
      message: "Selected runtime must be the only active runtime",
    });
  }
});

export const AgentChatSelectionSchema = z.object({
  provider: SafeSlugSchema,
  model: ModelReferenceSchema,
  effort: AgentEffortSchema,
  source: z.enum(["saved", "default"]),
  authKind: z.enum(["platform", "api_key", "oauth_login"]),
}).strict();

export const AgentMessagingSelectionSchema = z.object({
  runtime: AgentRuntimeIdSchema,
  provider: SafeSlugSchema.nullable(),
  model: ModelReferenceSchema.nullable(),
  configured: z.boolean(),
}).strict().superRefine((selection, ctx) => {
  const hasPair = selection.provider !== null && selection.model !== null;
  if (selection.configured !== hasPair) {
    ctx.addIssue({
      code: "custom",
      path: ["configured"],
      message: "Configured messaging requires a provider and model pair",
    });
  }
});

export const AgentCurrentSelectionSchema = z.object({
  chat: AgentChatSelectionSchema,
  messaging: AgentMessagingSelectionSchema,
}).strict();

export const LegacyAgentModelSchema = z.object({
  id: ModelReferenceSchema,
  label: SafeLabelSchema,
  tier: SafeLabelSchema,
}).strict();
export const LegacyAgentKernelSchema = z.object({
  model: ModelReferenceSchema.nullable(),
  effort: AgentEffortSchema.nullable(),
}).strict();
export const LegacyAgentSettingsViewSchema = z.object({
  identity: z.record(z.string(), z.unknown()),
  kernel: LegacyAgentKernelSchema,
  availableModels: z.array(LegacyAgentModelSchema).max(32),
  availableEfforts: z.array(AgentEffortSchema).max(4),
  defaults: LegacyAgentKernelSchema,
}).strict();

function chatSelectionsMatch(
  left: z.infer<typeof AgentChatSelectionSchema>,
  right: z.infer<typeof AgentChatSelectionSchema>,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && left.source === right.source
    && left.authKind === right.authKind;
}

export const AgentSettingsViewSchema = LegacyAgentSettingsViewSchema.extend({
  contractVersion: z.literal(2),
  revision: z.number().int().min(0),
  chat: AgentChatSelectionSchema,
  runtime: AgentRuntimeSelectionSchema,
  providers: AgentProviderCatalogSchema,
  currentSelection: AgentCurrentSelectionSchema,
}).strict().superRefine((view, ctx) => {
  if (!chatSelectionsMatch(view.chat, view.currentSelection.chat)) {
    ctx.addIssue({ code: "custom", path: ["currentSelection", "chat"], message: "Chat selections differ" });
  }
  if (view.currentSelection.messaging.runtime !== view.runtime.selected) {
    ctx.addIssue({
      code: "custom",
      path: ["currentSelection", "messaging", "runtime"],
      message: "Messaging runtime must be selected",
    });
  }
  const chatProvider = view.providers.find((provider) =>
    provider.runtime === null
    && provider.id === view.chat.provider
    && provider.scopes.includes("chat")
  );
  if (!chatProvider?.models.some((model) => model.id === view.chat.model)) {
    ctx.addIssue({ code: "custom", path: ["chat", "model"], message: "Chat model is not cataloged" });
  }
  if (!view.availableModels.some((model) => model.id === view.chat.model)) {
    ctx.addIssue({ code: "custom", path: ["availableModels"], message: "Legacy model catalog is incomplete" });
  }
  const messaging = view.currentSelection.messaging;
  if (messaging.configured) {
    const provider = view.providers.find((candidate) =>
      candidate.runtime === messaging.runtime
      && candidate.id === messaging.provider
      && candidate.scopes.includes("messaging")
    );
    if (!provider?.models.some((model) => model.id === messaging.model)) {
      ctx.addIssue({
        code: "custom",
        path: ["currentSelection", "messaging", "model"],
        message: "Messaging model is not cataloged",
      });
    }
  }
});

export const AgentSettingsCompatibleViewSchema = z.union([
  AgentSettingsViewSchema,
  LegacyAgentSettingsViewSchema,
]);

const HttpsUrlSchema = z.string().min(8).max(2048).url().refine(
  (value) => URL.canParse(value) && new URL(value).protocol === "https:",
  { message: "Provider base URL must use HTTPS" },
);

export const AgentSettingsUpdateSchema = z.object({
  model: ModelReferenceSchema.optional(),
  effort: AgentEffortSchema.optional(),
  runtime: AgentRuntimeIdSchema.optional(),
  provider: SafeSlugSchema.optional(),
  messagingModel: ModelReferenceSchema.optional(),
  baseUrl: HttpsUrlSchema.optional(),
  revision: z.number().int().min(0).optional(),
}).strict().superRefine((update, ctx) => {
  const mutableFields = [
    update.model,
    update.effort,
    update.runtime,
    update.provider,
    update.messagingModel,
    update.baseUrl,
  ];
  if (mutableFields.every((value) => value === undefined)) {
    ctx.addIssue({ code: "custom", message: "At least one mutable field is required" });
  }
  const hasExtendedMutation = update.runtime !== undefined
    || update.provider !== undefined
    || update.messagingModel !== undefined
    || update.baseUrl !== undefined;
  if (hasExtendedMutation && update.revision === undefined) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "Revision is required" });
  }
  if ((update.provider === undefined) !== (update.messagingModel === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["provider"],
      message: "Provider and messaging model must be updated together",
    });
  }
  if (update.baseUrl !== undefined && update.provider === undefined) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Base URL requires provider selection" });
  }
});

export type AgentRuntimeId = z.infer<typeof AgentRuntimeIdSchema>;
export type AgentEffort = z.infer<typeof AgentEffortSchema>;
export type AgentAuthKind = z.infer<typeof AgentAuthKindSchema>;
export type AgentProviderAuthStatus = z.infer<typeof AgentProviderAuthStatusSchema>;
export type AgentModelDescriptor = z.infer<typeof AgentModelDescriptorSchema>;
export type AgentProviderDescriptor = z.infer<typeof AgentProviderDescriptorSchema>;
export type AgentRuntimeDescriptor = z.infer<typeof AgentRuntimeDescriptorSchema>;
export type AgentRuntimeSelection = z.infer<typeof AgentRuntimeSelectionSchema>;
export type AgentChatSelection = z.infer<typeof AgentChatSelectionSchema>;
export type AgentMessagingSelection = z.infer<typeof AgentMessagingSelectionSchema>;
export type AgentCurrentSelection = z.infer<typeof AgentCurrentSelectionSchema>;
export type LegacyAgentSettingsView = z.infer<typeof LegacyAgentSettingsViewSchema>;
export type AgentSettingsView = z.infer<typeof AgentSettingsViewSchema>;
export type AgentSettingsCompatibleView = z.infer<typeof AgentSettingsCompatibleViewSchema>;
export type AgentSettingsUpdate = z.infer<typeof AgentSettingsUpdateSchema>;
