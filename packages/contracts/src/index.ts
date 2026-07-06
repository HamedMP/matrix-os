import { z } from "zod/v4";

const SAFE_ID_BODY = /^[A-Za-z0-9_-]+$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UNSAFE_DISPLAY_TEXT = /(stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
const UNSAFE_ERROR_TEXT =
  /(postgres|sqlite|mysql|pipedream|twilio|openai|anthropic|constraint|stack trace|zod|issues|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
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
export const EventIdSchema = prefixedId("evt_");
export const ApprovalIdSchema = prefixedId("appr_");
export const RequestIdSchema = prefixedId("req_");
export const CorrelationIdSchema = prefixedId("corr_");
export const TerminalSessionIdSchema = referenceId(128);
export const WorktreeIdSchema = z.string().regex(/^wt_[a-z0-9]{12,40}$/, "Invalid worktree id");
export const CursorSchema = referenceId(160);
export const IsoTimestampSchema = z.string().regex(ISO_DATETIME, "Invalid ISO timestamp");
export const SafeDisplayStringSchema = boundedDisplayText(120, 512);
export const BoundedTextSchema = (maxChars = 4000, maxBytes = 16 * 1024) => boundedText(maxChars, maxBytes);

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
  "codingAgentsNativeMobileTerminal",
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

export const AgentThreadEventSchema = z.discriminatedUnion("type", [
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
    type: z.literal("file.changed"),
    path: safeRelativePath(),
    changeKind: z.enum(["created", "updated", "deleted", "renamed"]),
  }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("review.ready"),
    reviewId: referenceId(128),
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

export type AgentThreadEvent = z.infer<typeof AgentThreadEventSchema>;

export const AgentThreadSnapshotSchema = z.object({
  thread: AgentThreadSummarySchema,
  events: boundedListSchema(AgentThreadEventSchema, 200),
}).strict();

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

export const ProjectSummarySchema = z.object({
  id: ProjectIdSchema,
  label: SafeDisplayStringSchema,
  status: z.enum(["available", "missing", "stale", "unknown"]).default("unknown"),
  updatedAt: IsoTimestampSchema.optional(),
}).strict();

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
  terminalSessions: boundedListSchema(TerminalSessionSummarySchema, 50),
  recentActivity: boundedListSchema(ActivityEventSummarySchema, 100),
  limits: RuntimeLimitsSchema,
  serverTime: IsoTimestampSchema,
}).strict();

export type RuntimeSummary = z.infer<typeof RuntimeSummarySchema>;

export const FilePathSchema = safeRelativePath();
export const FileMetadataSchema = z.object({
  path: FilePathSchema,
  kind: z.enum(["file", "directory", "symlink", "unknown"]),
  sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
  etag: referenceId(160).optional(),
  updatedAt: IsoTimestampSchema.optional(),
}).strict();

export const ReviewFileDiffSchema = z.object({
  path: FilePathSchema,
  status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  additions: z.number().int().min(0).max(1_000_000),
  deletions: z.number().int().min(0).max(1_000_000),
  partial: z.boolean(),
}).strict();

export const PreviewSessionSummarySchema = z.object({
  id: referenceId(128),
  label: SafeDisplayStringSchema,
  status: z.enum(["starting", "running", "failed", "stopped", "unknown"]),
  origin: z.string().url().max(2048).optional(),
  updatedAt: IsoTimestampSchema.optional(),
}).strict();
