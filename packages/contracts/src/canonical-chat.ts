import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_ID_BODY = /^[A-Za-z0-9_-]+$/;
const UNSAFE_CLIENT_TEXT =
  /(postgres|sqlite|mysql|openai|anthropic|twilio|pipedream|constraint|stack trace|zod|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|bearer\s+|sk-[A-Za-z0-9_-]+|password\s*[=:]|token\s*[=:])/i;
const textEncoder = new TextEncoder();

function prefixedId(prefix: string) {
  return z.string()
    .min(prefix.length + 1)
    .max(prefix.length + 128)
    .startsWith(prefix)
    .refine((value) => SAFE_ID_BODY.test(value.slice(prefix.length)), {
      message: "Invalid identifier",
    });
}

function referenceId(max = 160) {
  return z.string()
    .min(1)
    .max(max)
    .regex(SAFE_REFERENCE, "Invalid reference identifier")
    .refine((value) => !value.includes(".."), {
      message: "Reference cannot contain traversal",
    });
}

function boundedText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      message: "Text exceeds byte limit",
    });
}

function safeDisplayText(maxChars: number, maxBytes: number) {
  return boundedText(maxChars, maxBytes).refine((value) => !UNSAFE_CLIENT_TEXT.test(value), {
    message: "Text is not safe for clients",
  });
}

export const CanonicalChatIdSchema = prefixedId("chat_");
export const CanonicalChatTurnIdSchema = prefixedId("cturn_");
export const CanonicalChatRunIdSchema = prefixedId("run_");
export const CanonicalChatMessageIdSchema = prefixedId("msg_");
export const CanonicalChatRequestIdSchema = prefixedId("req_");
export const CanonicalProviderInstanceIdSchema = referenceId(128);
export const CanonicalChatAttachmentKindSchema = z.enum(["file", "image", "diff", "structured_ref"]);

export const CanonicalOwnerScopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("personal"),
    ownerId: referenceId(160),
  }).strict(),
  z.object({
    type: z.literal("organization"),
    ownerId: referenceId(160),
  }).strict(),
]);

export const CanonicalChatAttentionSchema = z.enum([
  "none",
  "approval_required",
  "input_required",
  "failed",
]);

export const CanonicalChatModelSelectionSchema = z.object({
  instanceId: CanonicalProviderInstanceIdSchema,
  model: referenceId(160),
  options: z.array(z.object({
    id: referenceId(80),
    value: z.union([referenceId(160), z.boolean()]),
  }).strict()).max(32).optional(),
}).strict();

export const CanonicalChatSchema = z.object({
  id: CanonicalChatIdSchema,
  ownerScope: CanonicalOwnerScopeSchema,
  title: boundedText(160, 640),
  lifecycle: z.enum(["active", "archived"]),
  attention: CanonicalChatAttentionSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastMessagePreview: boundedText(280, 1_120).optional(),
  currentSelection: CanonicalChatModelSelectionSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export const CanonicalChatTurnSchema = z.object({
  id: CanonicalChatTurnIdSchema,
  chatId: CanonicalChatIdSchema,
  clientRequestId: CanonicalChatRequestIdSchema,
  baseMessageSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  inputMessageId: CanonicalChatMessageIdSchema,
  status: z.enum(["accepted", "running", "completed", "failed", "aborted"]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export const CanonicalChatRunSchema = z.object({
  id: CanonicalChatRunIdSchema,
  chatId: CanonicalChatIdSchema,
  turnId: CanonicalChatTurnIdSchema,
  attempt: z.number().int().min(1).max(100),
  selection: CanonicalChatModelSelectionSchema,
  status: z.enum([
    "accepted",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "completed",
    "failed",
    "aborted",
  ]),
  outcome: z.enum(["completed", "failed", "aborted"]).optional(),
  historyBoundarySeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  capabilitySnapshotRevision: referenceId(160),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((run, ctx) => {
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "aborted";
  if (terminal !== (run.outcome !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "Run outcome must be present exactly for terminal states",
    });
  }
  if (run.outcome !== undefined && run.outcome !== run.status) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "Run outcome must match terminal status",
    });
  }
});

export const CanonicalChatMessagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: boundedText(32_000, 64 * 1024),
  }).strict(),
  z.object({
    type: z.literal("tool_request"),
    toolCallId: referenceId(128),
    name: safeDisplayText(120, 480),
    label: safeDisplayText(240, 960),
    inputPreview: safeDisplayText(1_000, 4_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: referenceId(128),
    outcome: z.enum(["success", "failed", "cancelled"]),
    text: boundedText(16_000, 64 * 1024).optional(),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("attachment_reference"),
    attachmentId: referenceId(128),
    kind: CanonicalChatAttachmentKindSchema,
    label: safeDisplayText(240, 960),
    mimeType: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9.+/-]+$/).optional(),
    sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
  }).strict(),
  z.object({
    type: z.literal("approval_request"),
    approvalId: referenceId(128),
    title: safeDisplayText(160, 640),
    description: safeDisplayText(1_000, 4_000),
    risk: z.enum(["low", "medium", "high"]),
    allowedDecisions: z.array(z.enum(["approve", "approve_for_session", "decline", "cancel"]))
      .min(1)
      .max(4),
  }).strict(),
  z.object({
    type: z.literal("approval_result"),
    approvalId: referenceId(128),
    decision: z.enum(["approve", "approve_for_session", "decline", "cancel"]),
  }).strict(),
  z.object({
    type: z.literal("status"),
    tone: z.enum(["info", "success", "warning", "error"]),
    label: safeDisplayText(240, 960),
    detail: safeDisplayText(1_000, 4_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("summary"),
    text: boundedText(16_000, 64 * 1024),
    source: z.enum(["assistant", "compaction", "user"]),
  }).strict(),
]);

export const CanonicalChatMessageSchema = z.object({
  id: CanonicalChatMessageIdSchema,
  chatId: CanonicalChatIdSchema,
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.enum(["pending", "committed", "failed"]),
  turnId: CanonicalChatTurnIdSchema.optional(),
  runId: CanonicalChatRunIdSchema.optional(),
  parts: z.array(CanonicalChatMessagePartSchema).min(1).max(64),
  createdAt: IsoTimestampSchema,
}).strict();

const CanonicalChatRunActivityBaseSchema = z.object({
  id: referenceId(128),
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  occurredAt: IsoTimestampSchema,
});

export const CanonicalChatRunActivitySchema = z.discriminatedUnion("type", [
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("run.status"),
    status: z.enum([
      "accepted",
      "running",
      "waiting_for_approval",
      "waiting_for_input",
      "completed",
      "failed",
      "aborted",
    ]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("assistant.delta"),
    messageId: CanonicalChatMessageIdSchema,
    delta: boundedText(4_000, 16 * 1024),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("tool.progress"),
    toolCallId: referenceId(128),
    label: safeDisplayText(240, 960),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("approval.requested"),
    approvalId: referenceId(128),
    title: safeDisplayText(160, 640),
    risk: z.enum(["low", "medium", "high"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("approval.resolved"),
    approvalId: referenceId(128),
    decision: z.enum(["approve", "approve_for_session", "decline", "cancel"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("input.requested"),
    requestId: referenceId(128),
    title: safeDisplayText(160, 640),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("input.resolved"),
    requestId: referenceId(128),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("resource.changed"),
    resourceId: referenceId(160),
    resourceKind: z.enum(["file", "folder", "project", "task", "app", "terminal_session"]),
    changeKind: z.enum(["created", "updated", "deleted", "renamed"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("message.committed"),
    messageId: CanonicalChatMessageIdSchema,
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
]);

export const CanonicalChatSafeErrorSchema = z.object({
  code: z.enum([
    "chat_not_found",
    "chat_busy",
    "chat_conflict",
    "provider_unavailable",
    "run_failed",
    "resource_unavailable",
    "authorization_failed",
    "service_unavailable",
  ]),
  safeMessage: safeDisplayText(180, 720),
  retryable: z.boolean(),
  recoveryActions: z.array(z.enum([
    "retry",
    "select_provider",
    "open_setup_terminal",
    "start_new_chat",
    "return_to_project",
  ])).max(5).optional(),
}).strict();

export type CanonicalOwnerScope = z.infer<typeof CanonicalOwnerScopeSchema>;
export type CanonicalChatModelSelection = z.infer<typeof CanonicalChatModelSelectionSchema>;
export type CanonicalChat = z.infer<typeof CanonicalChatSchema>;
export type CanonicalChatTurn = z.infer<typeof CanonicalChatTurnSchema>;
export type CanonicalChatRun = z.infer<typeof CanonicalChatRunSchema>;
export type CanonicalChatMessagePart = z.infer<typeof CanonicalChatMessagePartSchema>;
export type CanonicalChatMessage = z.infer<typeof CanonicalChatMessageSchema>;
export type CanonicalChatRunActivity = z.infer<typeof CanonicalChatRunActivitySchema>;
export type CanonicalChatSafeError = z.infer<typeof CanonicalChatSafeErrorSchema>;
