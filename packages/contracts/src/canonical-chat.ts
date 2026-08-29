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

export const CanonicalChatIdSchema = prefixedId("chat_");
export const CanonicalChatTurnIdSchema = prefixedId("cturn_");
export const CanonicalChatRunIdSchema = prefixedId("run_");
export const CanonicalChatMessageIdSchema = prefixedId("msg_");
export const CanonicalChatRequestIdSchema = prefixedId("req_");
export const CanonicalProviderInstanceIdSchema = canonicalReferenceId(128);
export const CanonicalChatAttachmentKindSchema = z.enum(["file", "image", "diff", "structured_ref"]);
const CanonicalChatRelativePathSchema = z.string()
  .min(1)
  .max(4096)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000\r\n]+$/);

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
  path: CanonicalChatRelativePathSchema.optional(),
  revision: canonicalReferenceId(160).optional(),
}).strict().superRefine((resource, context) => {
  if (resource.path && resource.kind !== "file" && resource.kind !== "folder") {
    context.addIssue({ code: "custom", path: ["path"], message: "Only file and folder resources may include a path" });
  }
});

export const CanonicalChatCollaborationSchema = z.object({
  mode: z.enum(["private", "shared"]),
  membership: z.object({
    role: z.enum(["owner", "editor", "viewer"]),
    memberCount: z.number().int().min(1).max(10_000),
  }).strict().optional(),
}).strict().superRefine((collaboration, ctx) => {
  if (collaboration.mode === "shared" && collaboration.membership === undefined) {
    ctx.addIssue({ code: "custom", path: ["membership"], message: "Shared Chat requires membership" });
  }
});

export const CanonicalChatUserStateSchema = z.object({
  readThroughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pinned: z.boolean(),
  muted: z.boolean(),
}).strict();

export const CanonicalChatShellStateSchema = z.object({
  lastSurface: z.enum(["global", "project"]),
  inspectorOpen: z.boolean(),
}).strict();

export const CanonicalChatForkProvenanceSchema = z.object({
  parentChatId: CanonicalChatIdSchema,
  throughMessageId: CanonicalChatMessageIdSchema,
}).strict();

export const CanonicalChatSchema = z.object({
  id: CanonicalChatIdSchema,
  ownerScope: CanonicalOwnerScopeSchema,
  title: canonicalBoundedText(200, 1024),
  lifecycle: z.enum(["active", "archived"]),
  attention: CanonicalChatAttentionSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  collaboration: CanonicalChatCollaborationSchema.optional(),
  userState: CanonicalChatUserStateSchema.optional(),
  shellState: CanonicalChatShellStateSchema.optional(),
  forkProvenance: CanonicalChatForkProvenanceSchema.optional(),
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
  executionRootFingerprint: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional(),
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
  startedAt: IsoTimestampSchema.optional(),
  completedAt: IsoTimestampSchema.optional(),
  historyBoundarySeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  capabilitySnapshot: z.object({
    revision: canonicalReferenceId(160),
    rootChat: z.boolean(),
    attachments: z.array(CanonicalChatAttachmentKindSchema).max(8),
    resources: z.array(CanonicalChatResourceKindSchema).max(6),
    tools: z.array(canonicalReferenceId(80)).max(128),
    approvals: z.boolean(),
    userInput: z.boolean(),
    resume: z.boolean(),
    cancellation: z.boolean(),
    worktrees: z.enum(["none", "optional", "required"]),
    interactionModes: z.array(canonicalReferenceId(80)).max(16),
    permissionModes: z.array(canonicalReferenceId(80)).max(16),
  }).strict(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((run, ctx) => {
  if (run.instanceId !== run.selection.instanceId) {
    ctx.addIssue({ code: "custom", path: ["selection", "instanceId"], message: "Run Instance mismatch" });
  }
  if ((run.executionRoot === undefined) !== (run.executionRootFingerprint === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["executionRootFingerprint"],
      message: "Execution root and fingerprint must be stored together",
    });
  }
  if (new Set(run.capabilitySnapshot.attachments).size !== run.capabilitySnapshot.attachments.length) {
    ctx.addIssue({ code: "custom", path: ["capabilitySnapshot", "attachments"], message: "Duplicate attachment capability" });
  }
  if (new Set(run.capabilitySnapshot.tools).size !== run.capabilitySnapshot.tools.length) {
    ctx.addIssue({ code: "custom", path: ["capabilitySnapshot", "tools"], message: "Duplicate tool capability" });
  }
  for (const key of ["resources", "interactionModes", "permissionModes"] as const) {
    if (new Set(run.capabilitySnapshot[key]).size !== run.capabilitySnapshot[key].length) {
      ctx.addIssue({ code: "custom", path: ["capabilitySnapshot", key], message: "Duplicate capability" });
    }
  }
  if (!run.capabilitySnapshot.interactionModes.includes(run.interactionMode)) {
    ctx.addIssue({ code: "custom", path: ["interactionMode"], message: "Interaction mode is not in the Run snapshot" });
  }
  if (!run.capabilitySnapshot.permissionModes.includes(run.permissionMode)) {
    ctx.addIssue({ code: "custom", path: ["permissionMode"], message: "Permission mode is not in the Run snapshot" });
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
  if (run.status !== "accepted" && run.startedAt === undefined) {
    ctx.addIssue({ code: "custom", path: ["startedAt"], message: "Started Run requires startedAt" });
  }
  if (terminal !== (run.completedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal Run requires completedAt" });
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
    sizeBytes: z.number().int().min(0).max(5 * 1024 * 1024).optional(),
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
    if (message.state !== "committed") {
      ctx.addIssue({ code: "custom", path: ["state"], message: "Canonical user messages must be committed" });
    }
    const textParts = message.parts.filter(
      (part): part is Extract<CanonicalChatMessagePart, { type: "text" }> => part.type === "text",
    );
    const totalCharacters = textParts.reduce((total, part) => total + part.text.length, 0);
    const totalBytes = textParts.reduce((total, part) => total + textEncoder.encode(part.text).byteLength, 0);
    if (totalCharacters > 24_000 || totalBytes > 96 * 1024) {
      ctx.addIssue({ code: "custom", path: ["parts"], message: "User message exceeds aggregate limit" });
    }
    message.parts.forEach((part, index) => {
      if (part.type === "text"
        && (part.text.length > 24_000 || textEncoder.encode(part.text).byteLength > 96 * 1024)) {
        ctx.addIssue({ code: "custom", path: ["parts", index, "text"], message: "User message exceeds limit" });
      }
    });
  }
  if (message.parts.filter((part) => part.type === "attachment_reference").length > 8) {
    ctx.addIssue({ code: "custom", path: ["parts"], message: "Message exceeds attachment limit" });
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
    type: z.literal("turn.status"),
    turnId: CanonicalChatTurnIdSchema,
    status: z.enum(["accepted", "running", "completed", "failed", "aborted"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("assistant.delta"),
    messageId: CanonicalChatMessageIdSchema,
    delta: canonicalBoundedText(4_000, 16 * 1024),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("tool.output"),
    toolCallId: canonicalReferenceId(128),
    text: canonicalSafeErrorText(4_000, 16 * 1024),
    truncated: z.boolean(),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("tool.progress"),
    toolCallId: canonicalReferenceId(128),
    label: canonicalSafeLabel(240, 960),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("review.ready"),
    reviewId: canonicalReferenceId(128),
    summary: z.object({
      changedFileCount: z.number().int().min(0).max(10_000),
      additions: z.number().int().min(0).max(1_000_000),
      deletions: z.number().int().min(0).max(1_000_000),
      partial: z.boolean(),
    }).strict(),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("terminal.bound"),
    terminalSessionId: canonicalReferenceId(128),
    terminalSessionCreatedAt: z.iso.datetime(),
  }).strict(),
  CanonicalChatRunActivityBaseSchema.extend({
    type: z.literal("run.error"),
    error: CanonicalChatSafeErrorSchema,
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

export type CanonicalOwnerScope = z.infer<typeof CanonicalOwnerScopeSchema>;
export type CanonicalChatModelSelection = z.infer<typeof CanonicalChatModelSelectionSchema>;
export type CanonicalChatAttachmentKind = z.infer<typeof CanonicalChatAttachmentKindSchema>;
export type CanonicalChatResourceKind = z.infer<typeof CanonicalChatResourceKindSchema>;
export type CanonicalChatInvocation = z.infer<typeof CanonicalChatInvocationSchema>;
export type CanonicalChatResourceReference = z.infer<typeof CanonicalChatResourceReferenceSchema>;
export type CanonicalChatCollaboration = z.infer<typeof CanonicalChatCollaborationSchema>;
export type CanonicalChatUserState = z.infer<typeof CanonicalChatUserStateSchema>;
export type CanonicalChatShellState = z.infer<typeof CanonicalChatShellStateSchema>;
export type CanonicalChatForkProvenance = z.infer<typeof CanonicalChatForkProvenanceSchema>;
export type CanonicalChat = z.infer<typeof CanonicalChatSchema>;
export type CanonicalChatTurn = z.infer<typeof CanonicalChatTurnSchema>;
export type CanonicalChatRun = z.infer<typeof CanonicalChatRunSchema>;
export type CanonicalChatMessagePart = z.infer<typeof CanonicalChatMessagePartSchema>;
export type CanonicalChatMessage = z.infer<typeof CanonicalChatMessageSchema>;
export type CanonicalChatRunActivity = z.infer<typeof CanonicalChatRunActivitySchema>;
export type CanonicalChatSafeError = z.infer<typeof CanonicalChatSafeErrorSchema>;
