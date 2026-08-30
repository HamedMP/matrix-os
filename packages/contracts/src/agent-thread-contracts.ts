import { z } from "zod/v4";
import { IsoTimestampSchema, SAFE_SLUG } from "#contract-primitives";
import { SafeClientErrorSchema } from "#safe-client-error";
import {
  byteLength,
  boundedDisplayText,
  boundedText,
  prefixedId,
  referenceId,
  safeRelativePath,
} from "#legacy-contract-primitives";

const ProviderIdSchema = z.string().min(1).max(80).regex(SAFE_SLUG, "Invalid provider id");
const ProjectIdSchema = referenceId(160);
const TaskIdSchema = prefixedId("task_");
const ThreadIdSchema = prefixedId("thread_");
const AgentTurnIdSchema = prefixedId("turn_");
const EventIdSchema = prefixedId("evt_");
const ApprovalIdSchema = prefixedId("appr_");
const RequestIdSchema = prefixedId("req_");
const CorrelationIdSchema = prefixedId("corr_");
const TerminalSessionIdSchema = referenceId(128);
const ReviewIdSchema = referenceId(128);
const CursorSchema = referenceId(160);
const SafeDisplayStringSchema = boundedDisplayText(120, 512);
const AssistantTextDeltaSchema = z.string()
  .min(1)
  .max(4_000)
  .refine((value) => byteLength(value) <= 16 * 1024, { message: "Text exceeds byte limit" });

export const AgentThreadStatusSchema = z.enum([
  "queued", "starting", "running", "waiting_for_approval", "waiting_for_input",
  "completed", "failed", "aborted", "stale", "archived",
]);
export const AgentAttentionSchema = z.enum([
  "none", "approval_required", "input_required", "failed", "completed",
]);
export const AgentTurnStatusSchema = z.enum(["accepted", "running", "completed", "failed", "aborted"]);

export const AgentAttachmentSchema = z.object({
  id: referenceId(128),
  kind: z.enum(["file", "diff", "image", "log_excerpt", "structured_ref"]),
  label: SafeDisplayStringSchema,
  path: safeRelativePath().optional(),
  mimeType: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9.+/-]+$/).optional(),
  sizeBytes: z.number().int().min(0).max(5 * 1024 * 1024).optional(),
}).strict();

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

export const ApprovalDecisionSchema = z.enum(["approve", "approve_for_session", "decline", "cancel"]);
export const ApprovalRiskSchema = z.enum(["low", "medium", "high"]);
export const ApprovalActionKindSchema = z.enum(["command", "file_change", "network", "provider", "other"]);

export const ApprovalPreviewSchema = z.object({
  title: SafeDisplayStringSchema.optional(),
  body: boundedDisplayText(2_000, 8 * 1024).optional(),
  truncated: z.boolean().default(false),
}).strict();

export const AgentApprovalRequestSchema = z.object({
  approvalId: ApprovalIdSchema,
  threadId: ThreadIdSchema,
  title: SafeDisplayStringSchema,
  safeDescription: boundedDisplayText(600, 2_400),
  risk: ApprovalRiskSchema,
  actionKind: ApprovalActionKindSchema,
  preview: ApprovalPreviewSchema.optional(),
  allowedDecisions: z.array(ApprovalDecisionSchema).min(1).max(4),
  expiresAt: IsoTimestampSchema.optional(),
  correlationId: CorrelationIdSchema,
}).strict();

export const UserInputOptionSchema = z.object({
  label: SafeDisplayStringSchema,
  description: boundedDisplayText(300, 1_200),
}).strict();

const UserInputOptionListSchema = z.array(UserInputOptionSchema).min(1).max(10)
  .superRefine((options, context) => {
    const seenLabels = new Set<string>();
    options.forEach((option, index) => {
      if (seenLabels.has(option.label)) {
        context.addIssue({ code: "custom", message: "Option labels must be unique", path: [index, "label"] });
      }
      seenLabels.add(option.label);
    });
  });

export const UserInputQuestionSchema = z.object({
  questionId: referenceId(128),
  header: SafeDisplayStringSchema,
  question: boundedDisplayText(600, 2_400),
  options: UserInputOptionListSchema.optional(),
  allowOther: z.boolean().default(false),
  secret: z.boolean().default(false),
}).strict();

const UserInputQuestionListSchema = z.array(UserInputQuestionSchema).min(1).max(8)
  .superRefine((questions, context) => {
    const seen = new Set<string>();
    questions.forEach((question, index) => {
      if (seen.has(question.questionId)) {
        context.addIssue({ code: "custom", message: "Question ids must be unique", path: [index, "questionId"] });
      }
      seen.add(question.questionId);
    });
  });

export const UserInputRequestSchema = z.object({
  requestId: RequestIdSchema,
  threadId: ThreadIdSchema,
  title: SafeDisplayStringSchema,
  safeDescription: boundedDisplayText(600, 2_400),
  placeholder: SafeDisplayStringSchema.optional(),
  required: z.boolean().default(true),
  questions: UserInputQuestionListSchema.optional(),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).optional(),
  expiresAt: IsoTimestampSchema.optional(),
  correlationId: CorrelationIdSchema,
}).strict();

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

const CoreAgentThreadEventSchema = z.discriminatedUnion("type", [
  BaseThreadEventSchema.extend({ type: z.literal("thread.created"), thread: AgentThreadSummarySchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("thread.status"), status: AgentThreadStatusSchema }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("user.message"),
    messageId: referenceId(128),
    text: boundedText(24_000, 96 * 1024),
    clientRequestId: RequestIdSchema,
    turnId: AgentTurnIdSchema.optional(),
    attachments: z.array(AgentAttachmentSchema).max(8).optional(),
  }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("assistant.text.delta"), messageId: referenceId(128), delta: AssistantTextDeltaSchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("assistant.text.completed"), messageId: referenceId(128) }).strict(),
  BaseThreadEventSchema.extend({
    type: z.literal("tool.started"),
    toolCallId: referenceId(128),
    displayName: SafeDisplayStringSchema,
    kind: SafeDisplayStringSchema,
    preview: boundedDisplayText(1_000, 4_000).optional(),
    previewKind: z.enum(["command", "path", "text"]).optional(),
    detail: boundedDisplayText(2_000, 8_000).optional(),
  }).strict().superRefine((activity, context) => {
    if ((activity.preview === undefined) !== (activity.previewKind === undefined)) {
      context.addIssue({ code: "custom", message: "Tool preview and kind must be provided together" });
    }
  }),
  BaseThreadEventSchema.extend({ type: z.literal("tool.output"), toolCallId: referenceId(128), text: boundedText(4_000, 16 * 1024), truncated: z.boolean().optional() }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("tool.completed"), toolCallId: referenceId(128), outcome: z.enum(["success", "failed", "cancelled"]) }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("approval.requested"), approval: AgentApprovalRequestSchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("approval.resolved"), approvalId: ApprovalIdSchema, decision: ApprovalDecisionSchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("user_input.requested"), request: UserInputRequestSchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("user_input.answered"), requestId: RequestIdSchema, correlationId: CorrelationIdSchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("file.changed"), path: safeRelativePath(), changeKind: z.enum(["created", "updated", "deleted", "renamed"]) }).strict(),
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
    terminalSessionCreatedAt: IsoTimestampSchema.optional(),
  }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("thread.error"), error: SafeClientErrorSchema }).strict(),
  BaseThreadEventSchema.extend({ type: z.literal("thread.completed"), outcome: z.enum(["completed", "failed", "aborted"]) }).strict(),
]);

export const AgentThreadEventSchema = z.discriminatedUnion("type", [
  ...AgentTurnLifecycleEventSchema.options,
  ...CoreAgentThreadEventSchema.options,
]);

export const AgentThreadSnapshotSchema = z.object({
  thread: AgentThreadSummarySchema,
  events: z.object({
    items: z.array(AgentThreadEventSchema).max(200),
    hasMore: z.boolean(),
    nextCursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(200),
  }).strict(),
}).strict();

export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;
export type AgentThreadSummary = z.infer<typeof AgentThreadSummarySchema>;
export type AgentTurnLifecycleEvent = z.infer<typeof AgentTurnLifecycleEventSchema>;
export type AgentThreadEvent = z.infer<typeof AgentThreadEventSchema>;
export type AgentThreadSnapshot = z.infer<typeof AgentThreadSnapshotSchema>;
