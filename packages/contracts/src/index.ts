import { z } from "zod/v4";

const SAFE_ID_BODY = /^[A-Za-z0-9_-]+$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UNSAFE_DISPLAY_TEXT = /(stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
const UNSAFE_ASSISTANT_PREVIEW_TEXT =
  /(postgres(?:ql)?:\/\/|mysql:\/\/|sqlite:|pipedream|twilio|openai|anthropic|constraint|stack trace|zod|issues|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+|password\s*[=:]|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|token|secret|private key|db\.internal|localhost|127\.0\.0\.1)/i;
const UNSAFE_ERROR_TEXT =
  /(postgres|sqlite|mysql|pipedream|twilio|openai|anthropic|constraint|stack trace|zod|issues|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function hasIpv4AddressInVersionSuffix(value: string): boolean {
  const suffixStart = value.indexOf("-");
  if (suffixStart === -1) return false;
  return /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^0-9])/.test(value.slice(suffixStart + 1));
}

function boundedText(maxChars: number, maxBytes = maxChars * 4) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => byteLength(value) <= maxBytes, { message: "Text exceeds byte limit" });
}

function boundedDisplayText(maxChars: number, maxBytes = maxChars * 4) {
  return boundedText(maxChars, maxBytes)
    .refine((value) => !UNSAFE_DISPLAY_TEXT.test(value), { message: "Text is not safe for display" });
}

function boundedSafeErrorText(maxChars: number, maxBytes = maxChars * 4) {
  return boundedText(maxChars, maxBytes)
    .refine((value) => !UNSAFE_ERROR_TEXT.test(value), { message: "Text is not safe for clients" });
}

function prefixedId(prefix: string, maxBody = 128) {
  return z.string()
    .min(prefix.length + 1)
    .max(prefix.length + maxBody)
    .startsWith(prefix)
    .refine((value) => SAFE_ID_BODY.test(value.slice(prefix.length)), { message: "Invalid identifier" });
}

function referenceId(max = 128) {
  return z.string()
    .min(1)
    .max(max)
    .regex(SAFE_REFERENCE, "Invalid reference identifier")
    .refine((value) => !value.includes(".."), { message: "Reference cannot contain traversal" });
}

function safeRelativePath(max = 512) {
  return z.string()
    .min(1)
    .max(max)
    .refine((value) => !value.startsWith("/") && !value.includes("\0"), { message: "Invalid path" })
    .refine((value) => !value.split(/[\\/]+/).some((part) => part === "" || part === "." || part === ".."), {
      message: "Path traversal is not allowed",
    });
}

export const RuntimeIdSchema = prefixedId("rt_");
export const ProviderIdSchema = z.string().min(1).max(80).regex(SAFE_SLUG, "Invalid provider id");
export const ProjectIdSchema = referenceId(160);
export const TaskIdSchema = prefixedId("task_");
export const ThreadIdSchema = prefixedId("thread_");
export const AgentTurnIdSchema = prefixedId("turn_");
export const EventIdSchema = prefixedId("evt_");
export const ApprovalIdSchema = prefixedId("appr_");
export const RequestIdSchema = prefixedId("req_");
export const CorrelationIdSchema = prefixedId("corr_");
export const TerminalSessionIdSchema = referenceId(128);
export const ReviewIdSchema = referenceId(128);
export const WorktreeIdSchema = z.string().regex(/^wt_[a-z0-9]{12,40}$/, "Invalid worktree id");
export const CursorSchema = referenceId(160);
export const IsoTimestampSchema = z.string().regex(ISO_DATETIME, "Invalid ISO timestamp");
export const SafeDisplayStringSchema = boundedDisplayText(120, 512);
export const SafeAssistantPreviewSourceTextSchema = boundedText(16_000, 64 * 1024)
  .refine((value) => !UNSAFE_ASSISTANT_PREVIEW_TEXT.test(value), { message: "Text is not safe for assistant preview display" });
export const SafeAssistantPreviewTextSchema = boundedText(243, 1024)
  .refine((value) => !UNSAFE_ASSISTANT_PREVIEW_TEXT.test(value), { message: "Text is not safe for assistant preview display" });
export const BoundedTextSchema = (maxChars = 4000, maxBytes = 16 * 1024) => boundedText(maxChars, maxBytes);
// Everything in this package lives inline in index.ts by design: the file is
// consumed as raw TS source by plain Node (type stripping) on customer VPSes,
// where nodenext-style "./module.js" relative specifiers do NOT resolve to
// .ts files. A relative re-export here took down gateway startup fleet-wide
// (rolled back by the sync agent) -- do not add relative imports/re-exports.
const UNSAFE_AGENT_PROFILE_TEXT =
  /(postgres(?:ql)?:\/\/|mysql:\/\/|sqlite:|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+|password\s*[=:]|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})/i;

function agentProfileDisplayText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      message: "Text exceeds byte limit",
    })
    .refine((value) => !UNSAFE_AGENT_PROFILE_TEXT.test(value), {
      message: "Text is not safe for agent profile display",
    });
}

export const AgentProfileSummarySchema = z.object({
  identity: z.object({
    name: agentProfileDisplayText(80, 320).optional(),
    tagline: agentProfileDisplayText(180, 720).optional(),
  }).strict(),
  kernel: z.object({
    model: z.string().min(1).max(80).regex(SAFE_REFERENCE, "Invalid kernel model"),
    modelLabel: agentProfileDisplayText(120, 512),
    effort: z.enum(["low", "medium", "high", "max"]),
  }).strict(),
  credentials: z.object({
    mode: z.enum(["platform", "api_key", "claude_login"]),
  }).strict(),
  soulPreview: agentProfileDisplayText(280, 1_120),
}).strict();

export type AgentProfileSummary = z.infer<typeof AgentProfileSummarySchema>;

export const MatrixComputerHandleSchema = z.string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Invalid Matrix computer handle");
export const MatrixComputerRuntimeSlotSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Invalid Matrix computer runtime slot");
export const MatrixComputerAvailabilitySchema = z.enum(["available", "starting", "unavailable"]);
export const MatrixComputerKindSchema = z.enum(["customer", "preview"]);
export const MatrixComputerLabelSchema = z.enum(["Main Computer", "Preview Computer", "Additional Computer"]);
export const MatrixComputerVersionLabelSchema = z.preprocess((value) => {
  if (typeof value !== "string" || value.length > 128) return value;
  const legacyChannel = value.match(/^matrix-os-host-(stable|dev|canary|beta)$/)?.[1];
  if (legacyChannel) return legacyChannel;
  const legacyRelease = value.match(/^matrix-os-host-(\d{4}\.\d{2}\.\d{2})(?:$|-)/)?.[1];
  return legacyRelease ? `v${legacyRelease}` : value;
}, z.union([
  z.literal("Version pending"),
  z.enum(["stable", "dev", "canary", "beta"]),
  z.string()
    .max(64)
    .regex(
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
      "Invalid Matrix computer version label",
    )
    .refine(
      (value) =>
        !UNSAFE_ASSISTANT_PREVIEW_TEXT.test(value) &&
        !/(?:machine|server)[._-]?id/i.test(value) &&
        !hasIpv4AddressInVersionSuffix(value),
      { message: "Matrix computer version label is not safe for display" },
    ),
]));
export const MatrixComputerCapabilityIdSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z][A-Za-z0-9]{0,79}$/, "Invalid Matrix computer capability id");
export const MatrixComputerSchema = z.object({
  handle: MatrixComputerHandleSchema,
  runtimeSlot: MatrixComputerRuntimeSlotSchema,
  label: MatrixComputerLabelSchema,
  availability: MatrixComputerAvailabilitySchema,
  kind: MatrixComputerKindSchema,
  versionLabel: MatrixComputerVersionLabelSchema.optional(),
  gatewayPath: z.string().min(6).max(108),
  capabilities: z.array(MatrixComputerCapabilityIdSchema).max(64),
}).strict().superRefine((computer, ctx) => {
  const expectedGatewayPath = computer.runtimeSlot === "primary"
    ? `/vm/${computer.handle}`
    : `/vm/${computer.handle}?runtime=${computer.runtimeSlot}`;
  if (computer.gatewayPath !== expectedGatewayPath) {
    ctx.addIssue({
      code: "custom",
      message: "Gateway path must match the Matrix computer handle and runtime slot",
      path: ["gatewayPath"],
    });
  }
});

export const MatrixComputerListSchema = z.object({
  items: z.array(MatrixComputerSchema).max(20),
  hasMore: z.boolean(),
  limit: z.number().int().min(1).max(20),
  selectedSlot: MatrixComputerRuntimeSlotSchema.nullable(),
}).strict().refine((list) => list.items.length <= list.limit, {
  message: "Items cannot exceed the requested limit",
  path: ["items"],
}).refine((list) => new Set(list.items.map((item) => item.runtimeSlot)).size === list.items.length, {
  message: "Runtime slots must be unique within the computer inventory",
  path: ["items"],
}).refine((list) => list.selectedSlot === null || list.items.some((item) => item.runtimeSlot === list.selectedSlot), {
  message: "Selected slot must be present in the computer inventory",
  path: ["selectedSlot"],
});

export type MatrixComputerHandle = z.infer<typeof MatrixComputerHandleSchema>;
export type MatrixComputerRuntimeSlot = z.infer<typeof MatrixComputerRuntimeSlotSchema>;
export type MatrixComputerAvailability = z.infer<typeof MatrixComputerAvailabilitySchema>;
export type MatrixComputerKind = z.infer<typeof MatrixComputerKindSchema>;
export type MatrixComputerLabel = z.infer<typeof MatrixComputerLabelSchema>;
export type MatrixComputerVersionLabel = z.infer<typeof MatrixComputerVersionLabelSchema>;
export type MatrixComputerCapabilityId = z.infer<typeof MatrixComputerCapabilityIdSchema>;
export type MatrixComputer = z.infer<typeof MatrixComputerSchema>;
export type MatrixComputerList = z.infer<typeof MatrixComputerListSchema>;

export const RuntimeSelectionRequestSchema = z.object({
  slot: MatrixComputerRuntimeSlotSchema,
}).strict();
export const RuntimeSelectionResponseSchema = z.object({
  accessToken: z.string().min(32).max(8192),
  expiresAt: z.number().int().min(1_000_000_000_000).max(Number.MAX_SAFE_INTEGER),
  handle: MatrixComputerHandleSchema,
  slot: MatrixComputerRuntimeSlotSchema,
}).strict();

export type RuntimeSelectionRequest = z.infer<typeof RuntimeSelectionRequestSchema>;
export type RuntimeSelectionResponse = z.infer<typeof RuntimeSelectionResponseSchema>;

export const RecoveryActionSchema = z.enum([
  "retry",
  "sign_in",
  "select_runtime",
  "open_setup_terminal",
  "resume",
  "start_new_session",
  "return_home",
]);

export const SafeClientErrorSchema = z.object({
  code: z.string().min(1).max(80).regex(SAFE_SLUG),
  safeMessage: boundedSafeErrorText(180, 720),
  retryable: z.boolean(),
  recoveryActions: z.array(RecoveryActionSchema).max(6).optional(),
}).strict();

export type SafeClientError = z.infer<typeof SafeClientErrorSchema>;

export function boundedListSchema<T extends z.ZodType>(itemSchema: T, maxItems: number) {
  return z.object({
    items: z.array(itemSchema).max(maxItems),
    hasMore: z.boolean(),
    nextCursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(maxItems),
  }).strict();
}

export const RuntimeStatusSchema = z.enum(["available", "degraded", "offline", "unknown"]);
export const RuntimeCapabilityIdSchema = z.enum([
  "codingAgentsRuntimeSummary",
  "codingAgentsDesktopWorkspace",
  "codingAgentsMobileWorkspace",
  "codingAgentsThreadCreate",
  "codingAgentsApprovals",
  "codingAgentsReview",
  "codingAgentsPreview",
  "codingAgentsFiles",
  "codingAgentsSourceControl",
  "codingAgentsNativeMobileTerminal",
  "codingAgentsProjectWorkspace",
  "codingAgentsSameThreadTurns",
  "codingAgentsConversationView",
  "codingAgentsKanbanView",
]);

export const RuntimeTargetSchema = z.object({
  id: RuntimeIdSchema,
  label: SafeDisplayStringSchema,
  status: RuntimeStatusSchema,
  channel: z.string().min(1).max(40).regex(SAFE_SLUG).optional(),
  ownerHandle: z.string().min(1).max(80).regex(SAFE_SLUG).optional(),
}).strict();

export const RuntimeCapabilitySchema = z.object({
  id: RuntimeCapabilityIdSchema,
  enabled: z.boolean(),
  reason: SafeDisplayStringSchema.optional(),
}).strict();

export const RuntimeLimitsSchema = z.object({
  maxPromptBytes: z.number().int().min(1).max(256 * 1024),
  maxAttachmentCount: z.number().int().min(0).max(32),
  maxTerminalInputBytes: z.number().int().min(1).max(256 * 1024),
  maxListItems: z.number().int().min(1).max(200),
}).strict();

export const CodingAgentAttentionNotificationKindSchema = z.enum(["approval", "input", "failed", "completed"]);

export const CodingAgentNotificationPreferencesSchema = z.object({
  attentionPush: z.object({
    approval: z.boolean(),
    input: z.boolean(),
    failed: z.boolean(),
    completed: z.boolean().default(true),
  }).strict(),
}).strict();

export const CodingAgentNotificationPreferencesUpdateSchema = CodingAgentNotificationPreferencesSchema;

export type CodingAgentAttentionNotificationKind =
  z.infer<typeof CodingAgentAttentionNotificationKindSchema>;
export type CodingAgentNotificationPreferences =
  z.infer<typeof CodingAgentNotificationPreferencesSchema>;
export type CodingAgentNotificationPreferencesUpdate =
  z.infer<typeof CodingAgentNotificationPreferencesUpdateSchema>;

export const ProviderKindSchema = z.enum(["claude", "codex", "opencode", "cursor", "custom"]);
export const ProviderAvailabilitySchema = z.enum([
  "available",
  "setup_required",
  "auth_required",
  "installing",
  "unavailable",
  "unknown",
]);
export const ProviderInstallStatusSchema = z.enum(["installed", "missing", "installing", "failed", "unknown"]);
export const ProviderAuthStatusSchema = z.enum(["authenticated", "missing", "expired", "unknown"]);
export const AgentModeSchema = z.enum(["default", "plan", "review", "full_access"]);
export const ApprovalPolicySchema = z.enum(["untrusted", "on_request", "on_failure", "never"]);
export const SandboxModeSchema = z.enum(["read_only", "workspace_write", "full_access"]);

export const SafeSetupActionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: ProviderIdSchema,
    kind: z.literal("open_settings"),
    label: SafeDisplayStringSchema,
  }).strict(),
  z.object({
    id: ProviderIdSchema,
    kind: z.literal("foreground_terminal"),
    label: SafeDisplayStringSchema,
    command: boundedDisplayText(280, 1024),
  }).strict(),
]);

export type SafeSetupAction = z.infer<typeof SafeSetupActionSchema>;

export const AgentProviderSummarySchema = z.object({
  id: ProviderIdSchema,
  displayName: SafeDisplayStringSchema,
  kind: ProviderKindSchema,
  availability: ProviderAvailabilitySchema,
  installStatus: ProviderInstallStatusSchema,
  authStatus: ProviderAuthStatusSchema,
  supportedModes: z.array(AgentModeSchema).min(1).max(8),
  defaultMode: AgentModeSchema,
  defaultModel: SafeDisplayStringSchema.optional(),
  setupActions: z.array(SafeSetupActionSchema).max(6),
  lastCheckedAt: IsoTimestampSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.supportedModes.includes(value.defaultMode)) {
    ctx.addIssue({ code: "custom", message: "Default mode must be supported", path: ["defaultMode"] });
  }
});

export type AgentProviderSummary = z.infer<typeof AgentProviderSummarySchema>;

export const AgentThreadStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "aborted",
  "stale",
  "archived",
]);

export const AgentAttentionSchema = z.enum(["none", "approval_required", "input_required", "failed", "completed"]);

export const AgentAttachmentSchema = z.object({
  id: referenceId(128),
  kind: z.enum(["file", "diff", "image", "log_excerpt", "structured_ref"]),
  label: SafeDisplayStringSchema,
  path: safeRelativePath().optional(),
  mimeType: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9.+/-]+$/).optional(),
  sizeBytes: z.number().int().min(0).max(5 * 1024 * 1024).optional(),
}).strict();

export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;

export const CreateAgentThreadRequestSchema = z.object({
  providerId: ProviderIdSchema,
  prompt: boundedText(24_000, 96 * 1024),
  projectId: ProjectIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  terminalSessionId: TerminalSessionIdSchema.optional(),
  worktreeId: WorktreeIdSchema.optional(),
  mode: AgentModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  attachments: z.array(AgentAttachmentSchema).max(8).optional(),
  clientRequestId: RequestIdSchema,
}).strict();

export type CreateAgentThreadRequest = z.infer<typeof CreateAgentThreadRequestSchema>;

export const AdoptAgentThreadRequestSchema = z.object({
  projectId: ProjectIdSchema,
  taskId: TaskIdSchema.optional(),
  clientRequestId: RequestIdSchema,
}).strict();

export type AdoptAgentThreadRequest = z.infer<typeof AdoptAgentThreadRequestSchema>;

export const CreateAgentTurnRequestSchema = z.object({
  message: boundedText(24_000, 96 * 1024),
  attachments: z.array(AgentAttachmentSchema).max(8).optional(),
  clientRequestId: RequestIdSchema,
}).strict();

export type CreateAgentTurnRequest = z.infer<typeof CreateAgentTurnRequestSchema>;

export const AgentTurnStatusSchema = z.enum(["accepted", "running", "completed", "failed", "aborted"]);

export const CreateAgentTurnResponseSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: AgentTurnIdSchema,
  status: z.enum(["accepted", "already_accepted"]),
  acceptedAt: IsoTimestampSchema,
}).strict();

export const CreateAgentTurnErrorCodeSchema = z.enum([
  "thread_busy",
  "thread_not_found",
  "turn_unavailable",
]);

export const CreateAgentTurnErrorSchema = SafeClientErrorSchema.extend({
  code: CreateAgentTurnErrorCodeSchema,
}).strict();

export type CreateAgentTurnResponse = z.infer<typeof CreateAgentTurnResponseSchema>;
export type CreateAgentTurnError = z.infer<typeof CreateAgentTurnErrorSchema>;

export const AgentThreadComposerDraftSchema = z.object({
  providerId: ProviderIdSchema.optional(),
  prompt: z.string()
    .max(24_000)
    .refine((value) => byteLength(value) <= 96 * 1024, { message: "Prompt exceeds byte limit" })
    .default(""),
  projectId: ProjectIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  terminalSessionId: TerminalSessionIdSchema.optional(),
  worktreeId: WorktreeIdSchema.optional(),
  mode: AgentModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  attachments: z.array(AgentAttachmentSchema).max(8).optional(),
}).strict();

export type AgentThreadComposerDraft = z.infer<typeof AgentThreadComposerDraftSchema>;

export const AgentThreadComposerIssueCodeSchema = z.enum([
  "thread_create_unavailable",
  "provider_required",
  "provider_unavailable",
  "prompt_required",
  "mode_unsupported",
  "invalid_request",
]);

export const AgentThreadComposerIssueSchema = z.object({
  code: AgentThreadComposerIssueCodeSchema,
  safeMessage: SafeDisplayStringSchema,
}).strict();

export type AgentThreadComposerIssue = z.infer<typeof AgentThreadComposerIssueSchema>;

export type AgentThreadComposerBuildResult =
  | { ok: true; request: CreateAgentThreadRequest }
  | { ok: false; issues: AgentThreadComposerIssue[] };

export const AgentThreadSummarySchema = z.object({
  id: ThreadIdSchema,
  providerId: ProviderIdSchema,
  title: SafeDisplayStringSchema,
  status: AgentThreadStatusSchema,
  attention: AgentAttentionSchema.default("none"),
  projectId: ProjectIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  terminalSessionId: TerminalSessionIdSchema.optional(),
  eventCursor: CursorSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type AgentThreadSummary = z.infer<typeof AgentThreadSummarySchema>;

export const AdoptAgentThreadResponseSchema = z.object({
  thread: AgentThreadSummarySchema,
  status: z.enum(["adopted", "already_adopted"]),
}).strict();

export type AdoptAgentThreadResponse = z.infer<typeof AdoptAgentThreadResponseSchema>;

export const ApprovalDecisionSchema = z.enum(["approve", "approve_for_session", "decline", "cancel"]);
export const ApprovalRiskSchema = z.enum(["low", "medium", "high"]);
export const ApprovalActionKindSchema = z.enum(["command", "file_change", "network", "provider", "other"]);

export const ApprovalPreviewSchema = z.object({
  title: SafeDisplayStringSchema.optional(),
  body: boundedDisplayText(2000, 8 * 1024).optional(),
  truncated: z.boolean().default(false),
}).strict();

export const AgentApprovalRequestSchema = z.object({
  approvalId: ApprovalIdSchema,
  threadId: ThreadIdSchema,
  title: SafeDisplayStringSchema,
  safeDescription: boundedDisplayText(600, 2400),
  risk: ApprovalRiskSchema,
  actionKind: ApprovalActionKindSchema,
  preview: ApprovalPreviewSchema.optional(),
  allowedDecisions: z.array(ApprovalDecisionSchema).min(1).max(4),
  expiresAt: IsoTimestampSchema.optional(),
  correlationId: CorrelationIdSchema,
}).strict();

export const ApprovalDecisionRequestSchema = z.object({
  decision: ApprovalDecisionSchema,
  clientRequestId: RequestIdSchema,
  correlationId: CorrelationIdSchema,
}).strict();

export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const UserInputRequestSchema = z.object({
  requestId: RequestIdSchema,
  threadId: ThreadIdSchema,
  title: SafeDisplayStringSchema,
  safeDescription: boundedDisplayText(600, 2400),
  placeholder: SafeDisplayStringSchema.optional(),
  required: z.boolean().default(true),
  expiresAt: IsoTimestampSchema.optional(),
  correlationId: CorrelationIdSchema,
}).strict();

export const UserInputAnswerRequestSchema = z.object({
  answer: boundedText(8000, 32 * 1024),
  clientRequestId: RequestIdSchema,
  correlationId: CorrelationIdSchema,
}).strict();

export type UserInputAnswerRequest = z.infer<typeof UserInputAnswerRequestSchema>;

const BaseThreadEventSchema = z.object({
  eventId: EventIdSchema,
  threadId: ThreadIdSchema,
  occurredAt: IsoTimestampSchema,
});

export const AgentTurnLifecycleEventSchema = z.discriminatedUnion("type", [
  BaseThreadEventSchema.extend({
    type: z.literal("turn.accepted"),
    turnId: AgentTurnIdSchema,
    clientRequestId: RequestIdSchema,
    acceptedAt: IsoTimestampSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("turn.status"),
    turnId: AgentTurnIdSchema,
    status: AgentTurnStatusSchema,
  }).strict(),
]);

export type AgentTurnLifecycleEvent = z.infer<typeof AgentTurnLifecycleEventSchema>;

const CoreAgentThreadEventSchema = z.discriminatedUnion("type", [
  BaseThreadEventSchema.extend({
    type: z.literal("thread.created"),
    thread: AgentThreadSummarySchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("thread.status"),
    status: AgentThreadStatusSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("assistant.text.delta"),
    messageId: referenceId(128),
    delta: boundedText(4000, 16 * 1024),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("assistant.text.completed"),
    messageId: referenceId(128),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.started"),
    toolCallId: referenceId(128),
    displayName: SafeDisplayStringSchema,
    kind: SafeDisplayStringSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.output"),
    toolCallId: referenceId(128),
    text: boundedText(4000, 16 * 1024),
    truncated: z.boolean().optional(),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.completed"),
    toolCallId: referenceId(128),
    outcome: z.enum(["success", "failed", "cancelled"]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("approval.requested"),
    approval: AgentApprovalRequestSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("approval.resolved"),
    approvalId: ApprovalIdSchema,
    decision: ApprovalDecisionSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("user_input.requested"),
    request: UserInputRequestSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("user_input.answered"),
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("file.changed"),
    path: safeRelativePath(),
    changeKind: z.enum(["created", "updated", "deleted", "renamed"]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("review.ready"),
    reviewId: ReviewIdSchema,
    summary: z.object({
      changedFileCount: z.number().int().min(0).max(10_000),
      additions: z.number().int().min(0).max(1_000_000),
      deletions: z.number().int().min(0).max(1_000_000),
      partial: z.boolean(),
    }).strict(),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("terminal.bound"),
    terminalSessionId: TerminalSessionIdSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("thread.error"),
    error: SafeClientErrorSchema,
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("thread.completed"),
    outcome: z.enum(["completed", "failed", "aborted"]),
  }).strict(),
]);

export const AgentThreadEventSchema = z.discriminatedUnion("type", [
  ...AgentTurnLifecycleEventSchema.options,
  ...CoreAgentThreadEventSchema.options,
]);

export type AgentThreadEvent = z.infer<typeof AgentThreadEventSchema>;

export const AgentThreadSnapshotSchema = z.object({
  thread: AgentThreadSummarySchema,
  events: boundedListSchema(AgentThreadEventSchema, 200),
}).strict();

export type AgentThreadSnapshot = z.infer<typeof AgentThreadSnapshotSchema>;

export const TerminalStatusSchema = z.enum(["starting", "running", "idle", "exited", "stale", "unavailable"]);

export const TerminalSessionSummarySchema = z.object({
  id: TerminalSessionIdSchema,
  name: SafeDisplayStringSchema,
  status: TerminalStatusSchema,
  attachable: z.boolean(),
  cwdLabel: SafeDisplayStringSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type TerminalSessionSummary = z.infer<typeof TerminalSessionSummarySchema>;

export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    sessionId: TerminalSessionIdSchema,
    fromSeq: z.number().int().min(0).optional(),
    cols: z.number().int().min(20).max(500).optional(),
    rows: z.number().int().min(5).max(200).optional(),
  }).strict(),
  z.object({
    type: z.literal("input"),
    data: z.string().min(1).max(64 * 1024),
  }).strict(),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }).strict(),
  z.object({
    type: z.literal("detach"),
  }).strict(),
]);

export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attached"),
    sessionId: TerminalSessionIdSchema.optional(),
    session: TerminalSessionIdSchema.optional(),
    state: z.enum(["running", "exited"]).optional(),
    exitCode: z.number().int().nullable().optional(),
    fromSeq: z.number().int().min(0).optional(),
    nextSeq: z.number().int().min(0).optional(),
  }).strict().superRefine((value, ctx) => {
    if (!value.sessionId && !value.session) {
      ctx.addIssue({ code: "custom", message: "Attached frame requires a session identifier", path: ["sessionId"] });
    }
  }),
  z.object({
    type: z.literal("output"),
    seq: z.number().int().min(0).optional(),
    data: z.string().min(1).max(64 * 1024),
  }).strict(),
  z.object({
    type: z.literal("replay-start"),
    fromSeq: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    type: z.literal("replay-evicted"),
    fromSeq: z.number().int().min(0).optional(),
    nextSeq: z.number().int().min(0),
  }).strict(),
  z.object({
    type: z.literal("replay-gap"),
    fromSeq: z.number().int().min(0).optional(),
    nextSeq: z.number().int().min(0),
  }).strict(),
  z.object({
    type: z.literal("replay-end"),
    nextSeq: z.number().int().min(0).optional(),
    toSeq: z.number().int().min(0).nullable().optional(),
  }).strict(),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int().nullable().optional(),
    code: z.number().int().nullable().optional(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1).max(80).regex(SAFE_SLUG),
    message: boundedSafeErrorText(180, 720),
  }).strict(),
  z.object({
    type: z.literal("safe-error"),
    error: SafeClientErrorSchema,
  }).strict(),
]);

export const BoundedAggregateCountSchema = z.number().int().min(0).max(1_000_000);

export const ProjectSummarySchema = z.object({
  id: ProjectIdSchema,
  label: SafeDisplayStringSchema,
  status: z.enum(["available", "missing", "stale", "unknown"]).default("unknown"),
  taskCount: BoundedAggregateCountSchema,
  threadCount: BoundedAggregateCountSchema,
  attentionCount: BoundedAggregateCountSchema,
  updatedAt: IsoTimestampSchema.optional(),
}).strict();

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

const CodingAgentProjectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const CodingAgentProjectCreateRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("scratch"),
    name: SafeDisplayStringSchema,
    slug: CodingAgentProjectSlugSchema.optional(),
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    mode: z.literal("github"),
    repositoryUrl: z.string().trim().min(1).max(512),
    slug: CodingAgentProjectSlugSchema.optional(),
    clientRequestId: RequestIdSchema,
  }).strict(),
]);
export const CodingAgentProjectCreateResponseSchema = z.object({
  project: ProjectSummarySchema,
  existing: z.boolean(),
}).strict();
export type CodingAgentProjectCreateRequest = z.infer<typeof CodingAgentProjectCreateRequestSchema>;
export type CodingAgentProjectCreateResponse = z.infer<typeof CodingAgentProjectCreateResponseSchema>;

export const CanonicalTaskStatusSchema = z.enum([
  "todo",
  "running",
  "waiting",
  "blocked",
  "complete",
  "archived",
]);
export const CanonicalTaskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const TaskAgentSummarySchema = z.object({
  id: TaskIdSchema,
  projectId: ProjectIdSchema,
  title: SafeDisplayStringSchema,
  status: CanonicalTaskStatusSchema,
  priority: CanonicalTaskPrioritySchema,
  order: z.number().int().min(0).max(1_000_000),
  threadCount: BoundedAggregateCountSchema,
  activeThreadCount: BoundedAggregateCountSchema,
  attentionCount: BoundedAggregateCountSchema,
  latestThreadAt: IsoTimestampSchema.optional(),
  revision: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict();

export type TaskAgentSummary = z.infer<typeof TaskAgentSummarySchema>;

const ProjectTaskSummaryListSchema = boundedListSchema(TaskAgentSummarySchema, 100);
const ProjectThreadSummaryListSchema = boundedListSchema(AgentThreadSummarySchema, 100);

export const ProjectAgentWorkspaceSchema = z.object({
  project: ProjectSummarySchema,
  tasks: ProjectTaskSummaryListSchema,
  projectThreads: ProjectThreadSummaryListSchema,
  taskThreads: ProjectThreadSummaryListSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((workspace, ctx) => {
  for (const [index, task] of workspace.tasks.items.entries()) {
    if (task.projectId !== workspace.project.id) {
      ctx.addIssue({ code: "custom", message: "Task project does not match workspace", path: ["tasks", "items", index, "projectId"] });
    }
  }
  for (const [index, thread] of workspace.projectThreads.items.entries()) {
    if (thread.projectId !== workspace.project.id || thread.taskId !== undefined) {
      ctx.addIssue({ code: "custom", message: "Project thread relation is invalid", path: ["projectThreads", "items", index] });
    }
  }
  for (const [index, thread] of workspace.taskThreads.items.entries()) {
    if (thread.projectId !== workspace.project.id || thread.taskId === undefined) {
      ctx.addIssue({ code: "custom", message: "Task thread relation is invalid", path: ["taskThreads", "items", index] });
    }
  }
});

export type ProjectAgentWorkspace = z.infer<typeof ProjectAgentWorkspaceSchema>;

const AgentThreadListLimitSchema = z.number().int().min(1).max(100).default(50);

export const AgentThreadListFilterSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("project"),
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: AgentThreadListLimitSchema,
  }).strict(),
  z.object({
    scope: z.literal("legacy_unassigned"),
    cursor: CursorSchema.optional(),
    limit: AgentThreadListLimitSchema,
  }).strict(),
]);

export type AgentThreadListFilter = z.infer<typeof AgentThreadListFilterSchema>;

export const PreviewSessionSummarySchema = z.object({
  id: referenceId(128),
  projectId: ProjectIdSchema.optional(),
  label: SafeDisplayStringSchema,
  status: z.enum(["starting", "running", "failed", "stopped", "unknown"]),
  origin: z.string().url().max(2048).optional(),
  updatedAt: IsoTimestampSchema.optional(),
}).strict();

export type PreviewSessionSummary = z.infer<typeof PreviewSessionSummarySchema>;

export const ActivityEventSummarySchema = z.object({
  id: EventIdSchema,
  kind: z.enum(["thread", "terminal", "provider", "runtime", "review", "preview"]),
  label: SafeDisplayStringSchema,
  occurredAt: IsoTimestampSchema,
}).strict();

export const RuntimeSummarySchema = z.object({
  runtime: RuntimeTargetSchema,
  capabilities: z.array(RuntimeCapabilitySchema).max(32),
  providers: z.array(AgentProviderSummarySchema).max(20),
  projects: boundedListSchema(ProjectSummarySchema, 50),
  activeThreads: boundedListSchema(AgentThreadSummarySchema, 50),
  attentionThreads: boundedListSchema(AgentThreadSummarySchema, 50).default({
    items: [],
    hasMore: false,
    limit: 20,
  }),
  terminalSessions: boundedListSchema(TerminalSessionSummarySchema, 50),
  previewSessions: boundedListSchema(PreviewSessionSummarySchema, 50).default({
    items: [],
    hasMore: false,
    limit: 50,
  }),
  recentActivity: boundedListSchema(ActivityEventSummarySchema, 100),
  limits: RuntimeLimitsSchema,
  serverTime: IsoTimestampSchema,
}).strict();

export type RuntimeSummary = z.infer<typeof RuntimeSummarySchema>;

function runtimeCapabilityEnabled(summary: RuntimeSummary, id: z.infer<typeof RuntimeCapabilityIdSchema>): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

function providerReady(provider: AgentProviderSummary): boolean {
  return provider.availability === "available" &&
    provider.installStatus === "installed" &&
    provider.authStatus === "authenticated";
}

function defaultComposerProvider(summary: RuntimeSummary): AgentProviderSummary | undefined {
  return summary.providers.find(providerReady) ?? summary.providers[0];
}

function composerIssue(code: z.infer<typeof AgentThreadComposerIssueCodeSchema>, safeMessage: string): AgentThreadComposerIssue {
  return AgentThreadComposerIssueSchema.parse({ code, safeMessage });
}

export function defaultAgentThreadComposerDraft(summaryInput: RuntimeSummary): AgentThreadComposerDraft {
  const summary = RuntimeSummarySchema.parse(summaryInput);
  const provider = defaultComposerProvider(summary);
  return AgentThreadComposerDraftSchema.parse({
    providerId: provider?.id,
    prompt: "",
    mode: provider?.defaultMode ?? "default",
    approvalPolicy: "on_request",
    sandboxMode: "workspace_write",
  });
}

export function buildCreateAgentThreadRequestFromComposer(input: {
  draft: unknown;
  summary: RuntimeSummary;
  clientRequestId: string;
}): AgentThreadComposerBuildResult {
  const summary = RuntimeSummarySchema.parse(input.summary);
  const draftResult = AgentThreadComposerDraftSchema.safeParse(input.draft);
  const clientRequestId = RequestIdSchema.safeParse(input.clientRequestId);
  if (!draftResult.success || !clientRequestId.success) {
    return {
      ok: false,
      issues: [composerIssue("invalid_request", "Agent run could not be started. Check the inputs and try again.")],
    };
  }

  const draft = draftResult.data;
  const providerId = draft.providerId ?? defaultComposerProvider(summary)?.id;
  const provider = providerId
    ? summary.providers.find((candidate) => candidate.id === providerId)
    : undefined;
  const mode = draft.mode ?? provider?.defaultMode ?? "default";
  const issues: AgentThreadComposerIssue[] = [];

  if (!runtimeCapabilityEnabled(summary, "codingAgentsThreadCreate")) {
    issues.push(composerIssue("thread_create_unavailable", "Agent runs are not available on this runtime yet."));
  }
  if (draft.prompt.trim().length === 0) {
    issues.push(composerIssue("prompt_required", "Enter a prompt before starting an agent run."));
  }
  if (!providerId) {
    issues.push(composerIssue("provider_required", "Choose an agent provider before starting a run."));
  } else if (!provider || !providerReady(provider)) {
    issues.push(composerIssue("provider_unavailable", "Selected provider is not ready. Choose another provider or finish setup."));
  }
  if (provider && !provider.supportedModes.includes(mode)) {
    issues.push(composerIssue("mode_unsupported", "Selected mode is not supported by this provider."));
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const request = CreateAgentThreadRequestSchema.safeParse({
    providerId,
    prompt: draft.prompt,
    projectId: draft.projectId,
    taskId: draft.taskId,
    terminalSessionId: draft.terminalSessionId,
    worktreeId: draft.worktreeId,
    mode,
    approvalPolicy: draft.approvalPolicy ?? "on_request",
    sandboxMode: draft.sandboxMode ?? "workspace_write",
    attachments: draft.attachments,
    clientRequestId: clientRequestId.data,
  });
  if (!request.success) {
    return {
      ok: false,
      issues: [composerIssue("invalid_request", "Agent run could not be started. Check the inputs and try again.")],
    };
  }
  return { ok: true, request: request.data };
}

export const FilePathSchema = safeRelativePath();
export const FileMetadataSchema = z.object({
  path: FilePathSchema,
  kind: z.enum(["file", "directory", "symlink", "unknown"]),
  sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
  etag: referenceId(160).optional(),
  updatedAt: IsoTimestampSchema.optional(),
}).strict();
export type FileMetadata = z.infer<typeof FileMetadataSchema>;
const FileProjectSlugSchema = ProjectIdSchema.refine((value) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(value), {
  message: "Invalid project slug",
});
export const FileReadRequestSchema = z.object({
  projectId: FileProjectSlugSchema,
  worktreeId: WorktreeIdSchema.optional(),
  path: FilePathSchema,
}).strict();
export const FileReadResponseSchema = z.object({
  metadata: FileMetadataSchema.extend({
    kind: z.literal("file"),
    sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024),
    etag: referenceId(160),
    updatedAt: IsoTimestampSchema,
  }),
  content: z.string()
    .max(65_536)
    .refine((value) => byteLength(value) <= 65_536, { message: "File content exceeds byte limit" }),
  encoding: z.literal("utf8"),
  truncated: z.boolean(),
  limitBytes: z.number().int().min(1).max(65_536),
}).strict();
export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;

const FileListLimitSchema = z.coerce.number().int().min(1).max(100).default(50);

export const FileBrowseRequestSchema = z.object({
  projectId: FileProjectSlugSchema,
  worktreeId: WorktreeIdSchema.optional(),
  path: FilePathSchema.optional(),
  limit: FileListLimitSchema,
}).strict();
export const FileBrowseResponseSchema = z.object({
  directory: FileMetadataSchema.extend({
    kind: z.literal("directory"),
    path: FilePathSchema.optional(),
  }),
  entries: boundedListSchema(FileMetadataSchema, 100),
}).strict();
export type FileBrowseRequest = z.infer<typeof FileBrowseRequestSchema>;
export type FileBrowseResponse = z.infer<typeof FileBrowseResponseSchema>;

export const FileSearchRequestSchema = z.object({
  projectId: FileProjectSlugSchema,
  worktreeId: WorktreeIdSchema.optional(),
  path: FilePathSchema.optional(),
  query: boundedText(80, 256),
  limit: FileListLimitSchema,
}).strict();
export const FileSearchResponseSchema = z.object({
  matches: boundedListSchema(FileMetadataSchema, 100),
}).strict();
export type FileSearchRequest = z.infer<typeof FileSearchRequestSchema>;
export type FileSearchResponse = z.infer<typeof FileSearchResponseSchema>;

const FileContentSchema = z.string()
  .max(65_536)
  .refine((value) => byteLength(value) <= 65_536, { message: "File content exceeds byte limit" });

export const FileWriteRequestSchema = z.object({
  projectId: ProjectIdSchema.refine((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value), {
    message: "Invalid project id",
  }),
  worktreeId: WorktreeIdSchema,
  path: FilePathSchema,
  content: FileContentSchema,
  encoding: z.literal("utf8"),
  baseEtag: referenceId(160).nullable(),
  clientRequestId: RequestIdSchema,
}).strict();
export const FileWriteResponseSchema = z.object({
  metadata: FileMetadataSchema.extend({
    kind: z.literal("file"),
    sizeBytes: z.number().int().min(0).max(65_536),
    etag: referenceId(160),
    updatedAt: IsoTimestampSchema,
  }),
  encoding: z.literal("utf8"),
  writtenBytes: z.number().int().min(0).max(65_536),
}).strict();
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;
export type FileWriteResponse = z.infer<typeof FileWriteResponseSchema>;

const SourceControlCommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "Invalid commit sha");
const SourceControlCommitMessageSchema = z.string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, { message: "Commit message is required" })
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), {
    message: "Commit message contains unsupported characters",
  });
const SourceControlBranchSchema = z.string()
  .min(1)
  .max(1024)
  .refine((value) => value === "detached" || (
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".lock") &&
    !/[~^:?*[\]\\\s\u0000-\u001F\u007F]/.test(value)
  ), { message: "Invalid branch name" });
const SourceControlPullRequestTitleSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0, { message: "Pull request title is required" })
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), {
    message: "Pull request title contains unsupported characters",
  });
const SourceControlPullRequestBodySchema = z.string()
  .max(16_384)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), {
    message: "Pull request body contains unsupported characters",
  });
const GitHubPullRequestUrlSchema = z.string()
  .url()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && url.hostname === "github.com"
        && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/.test(url.pathname);
    } catch (_err: unknown) {
      return false;
    }
  }, { message: "Invalid pull request URL" });

export const SourceControlPrepareCommitRequestSchema = z.object({
  projectId: ProjectIdSchema.refine((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value), {
    message: "Invalid project id",
  }),
  worktreeId: WorktreeIdSchema,
  message: SourceControlCommitMessageSchema,
  paths: z.array(FilePathSchema).min(1).max(100).optional(),
  clientRequestId: RequestIdSchema,
}).strict();

export const SourceControlPrepareCommitResponseSchema = z.object({
  status: z.literal("committed"),
  commitSha: SourceControlCommitShaSchema,
  branch: SourceControlBranchSchema,
  changedFileCount: z.number().int().min(1).max(1000),
  safeMessage: SafeDisplayStringSchema,
}).strict();

export const SourceControlCreatePullRequestRequestSchema = z.object({
  projectId: ProjectIdSchema.refine((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value), {
    message: "Invalid project id",
  }),
  worktreeId: WorktreeIdSchema,
  title: SourceControlPullRequestTitleSchema,
  body: SourceControlPullRequestBodySchema.optional(),
  baseBranch: SourceControlBranchSchema.optional(),
  draft: z.boolean().optional(),
  clientRequestId: RequestIdSchema,
}).strict();

export const SourceControlCreatePullRequestResponseSchema = z.object({
  status: z.enum(["created", "existing"]),
  number: z.number().int().min(1).max(1_000_000_000),
  url: GitHubPullRequestUrlSchema,
  headBranch: SourceControlBranchSchema,
  baseBranch: SourceControlBranchSchema,
  safeMessage: SafeDisplayStringSchema,
}).strict();

export type SourceControlPrepareCommitRequest = z.infer<typeof SourceControlPrepareCommitRequestSchema>;
export type SourceControlPrepareCommitResponse = z.infer<typeof SourceControlPrepareCommitResponseSchema>;
export type SourceControlCreatePullRequestRequest = z.infer<typeof SourceControlCreatePullRequestRequestSchema>;
export type SourceControlCreatePullRequestResponse = z.infer<typeof SourceControlCreatePullRequestResponseSchema>;

export const ReviewFileDiffSchema = z.object({
  path: FilePathSchema,
  status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  additions: z.number().int().min(0).max(1_000_000),
  deletions: z.number().int().min(0).max(1_000_000),
  partial: z.boolean(),
}).strict();

const ReviewDiffLineNumberSchema = z.number().int().min(1).max(1_000_000);
const ReviewDiffLineContentSchema = z.string()
  .max(1_000)
  .refine((value) => byteLength(value) <= 4_000, { message: "Diff line exceeds byte limit" });

export const ReviewDiffLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("context"),
    oldLine: ReviewDiffLineNumberSchema,
    newLine: ReviewDiffLineNumberSchema,
    content: ReviewDiffLineContentSchema,
  }).strict(),
  z.object({
    kind: z.literal("add"),
    newLine: ReviewDiffLineNumberSchema,
    content: ReviewDiffLineContentSchema,
  }).strict(),
  z.object({
    kind: z.literal("remove"),
    oldLine: ReviewDiffLineNumberSchema,
    content: ReviewDiffLineContentSchema,
  }).strict(),
]);

export const ReviewDiffHunkSchema = z.object({
  id: referenceId(128),
  oldStart: z.number().int().min(0).max(1_000_000),
  oldLines: z.number().int().min(0).max(1_000_000),
  newStart: z.number().int().min(0).max(1_000_000),
  newLines: z.number().int().min(0).max(1_000_000),
  heading: SafeDisplayStringSchema.optional(),
  partial: z.boolean(),
  lines: z.array(ReviewDiffLineSchema).max(120).optional(),
}).strict();

export const ReviewFindingSummarySchema = z.object({
  id: referenceId(128),
  severity: z.enum(["high", "medium", "low"]),
  line: z.number().int().min(1).max(1_000_000),
  summary: SafeDisplayStringSchema,
}).strict();

export const ReviewSnapshotFileSchema = ReviewFileDiffSchema.extend({
  hunks: z.array(ReviewDiffHunkSchema).max(100),
  findings: z.array(ReviewFindingSummarySchema).max(100).optional(),
}).strict();

export const ReviewSummarySchema = z.object({
  id: ReviewIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
  status: z.enum([
    "queued",
    "reviewing",
    "implementing",
    "verifying",
    "converged",
    "stalled",
    "failed",
    "failed_parse",
    "stopped",
    "approved",
  ]),
  pullRequestNumber: z.number().int().min(1).max(10_000_000),
  round: z.number().int().min(0).max(100),
  maxRounds: z.number().int().min(1).max(100),
  reviewer: ProviderIdSchema,
  implementer: ProviderIdSchema,
  findings: z.object({
    total: z.number().int().min(0).max(1_000_000),
    high: z.number().int().min(0).max(1_000_000),
    medium: z.number().int().min(0).max(1_000_000),
    low: z.number().int().min(0).max(1_000_000),
  }).strict().optional(),
  safeStatus: SafeDisplayStringSchema.optional(),
  updatedAt: IsoTimestampSchema,
}).strict();

export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

export const ReviewSnapshotSchema = z.object({
  review: ReviewSummarySchema,
  files: boundedListSchema(ReviewSnapshotFileSchema, 100),
  partial: z.boolean(),
  safeNotice: SafeDisplayStringSchema.optional(),
  updatedAt: IsoTimestampSchema,
}).strict();

export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;
