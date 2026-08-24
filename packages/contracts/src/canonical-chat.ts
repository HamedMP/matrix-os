import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";
import {
  CanonicalChatExecutionRootRefSchema,
  CanonicalProviderDriverKindSchema,
  canonicalBoundedText,
  canonicalEncodedByteLength,
  canonicalReferenceId,
  canonicalSafeErrorText,
  canonicalSafeLabel,
} from "#canonical-chat-primitives";

const SAFE_ID_BODY = /^[A-Za-z0-9_-]+$/;

function prefixedId(prefix: string) {
  return z.string()
    .min(prefix.length + 1)
    .max(prefix.length + 128)
    .startsWith(prefix)
    .refine((value) => SAFE_ID_BODY.test(value.slice(prefix.length)), {
      message: "Invalid identifier",
    });
}

export const CanonicalChatIdSchema = prefixedId("chat_");
export const CanonicalChatTurnIdSchema = prefixedId("cturn_");
export const CanonicalChatRunIdSchema = prefixedId("run_");
export const CanonicalChatMessageIdSchema = prefixedId("msg_");
export const CanonicalChatRequestIdSchema = prefixedId("req_");
export const CanonicalProviderInstanceIdSchema = canonicalReferenceId(128);
export const CanonicalChatAttachmentKindSchema = z.enum(["file", "image", "diff", "structured_ref"]);

export const CanonicalOwnerScopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("personal"),
    ownerId: canonicalReferenceId(160),
  }).strict(),
  z.object({
    type: z.literal("organization"),
    ownerId: canonicalReferenceId(160),
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
  model: canonicalReferenceId(160),
  options: z.array(z.object({
    id: canonicalReferenceId(80),
    value: z.union([canonicalReferenceId(160), z.boolean()]),
  }).strict()).max(32).optional(),
}).strict().superRefine((selection, ctx) => {
  const ids = selection.options?.map((option) => option.id) ?? [];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Duplicate option selection" });
  }
});

export const CanonicalChatInvocationSchema = z.object({
  kind: z.enum(["skill", "command"]),
  descriptorId: canonicalReferenceId(80),
  invocation: z.string().min(2).max(81).regex(/^\/[a-z][a-z0-9_-]{0,79}$/),
  arguments: canonicalBoundedText(4_000, 16 * 1024).optional(),
}).strict();

export const CanonicalChatResourceKindSchema = z.enum([
  "file",
  "folder",
  "project",
  "task",
  "app",
  "terminal_session",
]);

export const CanonicalChatResourceReferenceSchema = z.object({
  kind: CanonicalChatResourceKindSchema,
  id: canonicalReferenceId(160),
  label: canonicalSafeLabel(280, 1_120),
  revision: canonicalReferenceId(160).optional(),
}).strict();

export const CanonicalChatSchema = z.object({
  id: CanonicalChatIdSchema,
  ownerScope: CanonicalOwnerScopeSchema,
  title: canonicalBoundedText(200, 1024),
  lifecycle: z.enum(["active", "archived"]),
  attention: CanonicalChatAttentionSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastMessagePreview: canonicalBoundedText(280, 1_120).optional(),
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
  driverKind: CanonicalProviderDriverKindSchema,
  instanceId: CanonicalProviderInstanceIdSchema,
  selection: CanonicalChatModelSelectionSchema,
  interactionMode: canonicalReferenceId(80),
  permissionMode: canonicalReferenceId(80),
  executionRoot: CanonicalChatExecutionRootRefSchema.optional(),
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
  capabilitySnapshot: z.object({
    revision: canonicalReferenceId(160),
    attachments: z.array(CanonicalChatAttachmentKindSchema).max(8),
    tools: z.array(canonicalReferenceId(80)).max(128),
    approvals: z.boolean(),
    userInput: z.boolean(),
    resume: z.boolean(),
    cancellation: z.boolean(),
    worktrees: z.enum(["none", "optional", "required"]),
  }).strict(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((run, ctx) => {
  if (run.instanceId !== run.selection.instanceId) {
    ctx.addIssue({ code: "custom", path: ["selection", "instanceId"], message: "Run Instance mismatch" });
  }
  if (new Set(run.capabilitySnapshot.attachments).size !== run.capabilitySnapshot.attachments.length) {
    ctx.addIssue({ code: "custom", path: ["capabilitySnapshot", "attachments"], message: "Duplicate attachment capability" });
  }
  if (new Set(run.capabilitySnapshot.tools).size !== run.capabilitySnapshot.tools.length) {
    ctx.addIssue({ code: "custom", path: ["capabilitySnapshot", "tools"], message: "Duplicate tool capability" });
  }
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
    text: canonicalBoundedText(32_000, 96 * 1024),
  }).strict(),
  z.object({
    type: z.literal("tool_request"),
    toolCallId: canonicalReferenceId(128),
    name: canonicalSafeLabel(120, 480),
    label: canonicalSafeLabel(240, 960),
    inputPreview: canonicalSafeLabel(1_000, 4_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: canonicalReferenceId(128),
    outcome: z.enum(["success", "failed", "cancelled"]),
    text: canonicalBoundedText(16_000, 64 * 1024).optional(),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("attachment_reference"),
    attachmentId: canonicalReferenceId(128),
    kind: CanonicalChatAttachmentKindSchema,
    label: canonicalSafeLabel(240, 960),
    mimeType: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9.+/-]+$/).optional(),
    sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
  }).strict(),
  z.object({
    type: z.literal("approval_request"),
    approvalId: canonicalReferenceId(128),
    title: canonicalSafeLabel(160, 640),
    description: canonicalSafeLabel(1_000, 4_000),
    risk: z.enum(["low", "medium", "high"]),
    allowedDecisions: z.array(z.enum(["approve", "approve_for_session", "decline", "cancel"]))
      .min(1)
      .max(4),
  }).strict(),
  z.object({
    type: z.literal("approval_result"),
    approvalId: canonicalReferenceId(128),
    decision: z.enum(["approve", "approve_for_session", "decline", "cancel"]),
  }).strict(),
  z.object({
    type: z.literal("status"),
    tone: z.enum(["info", "success", "warning", "error"]),
    label: canonicalSafeLabel(240, 960),
    detail: canonicalSafeLabel(1_000, 4_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("summary"),
    text: canonicalBoundedText(16_000, 64 * 1024),
    source: z.enum(["assistant", "compaction", "user"]),
  }).strict(),
  z.object({
    type: z.literal("invocation_reference"),
    invocation: CanonicalChatInvocationSchema,
  }).strict(),
  z.object({
    type: z.literal("resource_reference"),
    resource: CanonicalChatResourceReferenceSchema,
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
}).strict().superRefine((message, ctx) => {
  if (canonicalEncodedByteLength(message) > 128 * 1024) {
    ctx.addIssue({ code: "custom", path: ["parts"], message: "Message exceeds encoded byte limit" });
  }
  if (message.role === "user") {
    message.parts.forEach((part, index) => {
      if (part.type === "text"
        && (part.text.length > 24_000 || new TextEncoder().encode(part.text).byteLength > 96 * 1024)) {
        ctx.addIssue({ code: "custom", path: ["parts", index, "text"], message: "User message exceeds limit" });
      }
    });
  }
  message.parts.forEach((part, index) => {
    if (part.type === "tool_result" && part.outcome === "failed" && part.text !== undefined
      && !canonicalSafeErrorText(16_000, 64 * 1024).safeParse(part.text).success) {
      ctx.addIssue({ code: "custom", path: ["parts", index, "text"], message: "Failed tool result is not safe" });
    }
  });
});

const CanonicalChatRunActivityBaseSchema = z.object({
  id: canonicalReferenceId(128),
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
    delta: canonicalBoundedText(4_000, 16 * 1024),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("tool.progress"),
    toolCallId: canonicalReferenceId(128),
    label: canonicalSafeLabel(240, 960),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("approval.requested"),
    approvalId: canonicalReferenceId(128),
    title: canonicalSafeLabel(160, 640),
    risk: z.enum(["low", "medium", "high"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("approval.resolved"),
    approvalId: canonicalReferenceId(128),
    decision: z.enum(["approve", "approve_for_session", "decline", "cancel"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("input.requested"),
    requestId: canonicalReferenceId(128),
    title: canonicalSafeLabel(160, 640),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("input.resolved"),
    requestId: canonicalReferenceId(128),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("resource.changed"),
    resourceId: canonicalReferenceId(160),
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
    "chat_unavailable",
    "project_required",
    "project_unavailable",
    "provider_unavailable",
    "provider_instance_locked",
    "model_unavailable",
    "capability_mismatch",
    "run_not_found",
    "run_not_resumable",
    "run_unavailable",
    "history_window_required",
    "migration_in_progress",
    "run_failed",
    "resource_unavailable",
    "authorization_failed",
    "service_unavailable",
  ]),
  safeMessage: canonicalSafeErrorText(180, 720),
  retryable: z.boolean(),
  recoveryActions: z.array(z.enum([
    "retry",
    "select_provider",
    "open_setup_terminal",
    "fork_chat",
    "start_new_chat",
    "return_to_project",
  ])).max(5).optional(),
}).strict().superRefine((error, ctx) => {
  if (error.code === "provider_instance_locked") {
    const actions = new Set(error.recoveryActions ?? []);
    if (!actions.has("fork_chat") || !actions.has("start_new_chat")) {
      ctx.addIssue({
        code: "custom",
        path: ["recoveryActions"],
        message: "Locked Provider errors require Fork and New Chat recovery",
      });
    }
  }
});

export type CanonicalOwnerScope = z.infer<typeof CanonicalOwnerScopeSchema>;
export type CanonicalChatModelSelection = z.infer<typeof CanonicalChatModelSelectionSchema>;
export type CanonicalChatInvocation = z.infer<typeof CanonicalChatInvocationSchema>;
export type CanonicalChatResourceReference = z.infer<typeof CanonicalChatResourceReferenceSchema>;
export type CanonicalChat = z.infer<typeof CanonicalChatSchema>;
export type CanonicalChatTurn = z.infer<typeof CanonicalChatTurnSchema>;
export type CanonicalChatRun = z.infer<typeof CanonicalChatRunSchema>;
export type CanonicalChatMessagePart = z.infer<typeof CanonicalChatMessagePartSchema>;
export type CanonicalChatMessage = z.infer<typeof CanonicalChatMessageSchema>;
export type CanonicalChatRunActivity = z.infer<typeof CanonicalChatRunActivitySchema>;
export type CanonicalChatSafeError = z.infer<typeof CanonicalChatSafeErrorSchema>;
