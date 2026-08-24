import { z } from "zod/v4";
import {
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatIdSchema,
  CanonicalChatRunSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatSchema,
  CanonicalChatTurnSchema,
  CanonicalChatTurnIdSchema,
  CanonicalProviderInstanceIdSchema,
} from "#canonical-chat";
import { CanonicalProviderDriverKindSchema } from "#canonical-chat-provider";
import { IsoTimestampSchema } from "#contract-primitives";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const UNSAFE_LABEL =
  /(^|\s)(?:\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/])|\.ssh\/|bearer\s+|sk-[A-Za-z0-9_-]+|password\s*[=:]|token\s*[=:]/i;
const textEncoder = new TextEncoder();

function referenceId(max = 160) {
  return z.string().min(1).max(max).regex(SAFE_REFERENCE)
    .refine((value) => !value.includes(".."), { message: "Invalid reference" });
}

function boundedText(maxChars: number, maxBytes: number) {
  return z.string().min(1).max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      message: "Text exceeds byte limit",
    });
}

function safeLabel(maxChars: number, maxBytes: number) {
  return boundedText(maxChars, maxBytes).refine((value) => !UNSAFE_LABEL.test(value), {
    message: "Label is not safe for clients",
  });
}

const SlashInvocationSchema = z.string().min(2).max(81).regex(/^\/[a-z][a-z0-9_-]{0,79}$/);

export const CanonicalChatInvocationSchema = z.object({
  kind: z.enum(["skill", "command"]),
  descriptorId: referenceId(80),
  invocation: SlashInvocationSchema,
  arguments: boundedText(4_000, 16 * 1024).optional(),
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
  id: referenceId(160),
  label: safeLabel(280, 1_120),
  revision: referenceId(160).optional(),
}).strict();

export const CanonicalChatProjectProjectionSchema = z.object({
  projectId: referenceId(160),
  name: safeLabel(160, 640),
  kind: z.enum(["scratch", "github", "folder"]),
  repositoryLabel: safeLabel(240, 960).optional(),
  status: z.enum(["ready", "unavailable"]),
}).strict();

export const CanonicalChatExecutionRootRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("project"),
    projectId: referenceId(160),
  }).strict(),
  z.object({
    kind: z.literal("worktree"),
    projectId: referenceId(160),
    worktreeId: referenceId(128),
  }).strict(),
]);

const CanonicalChatInspectorRunSchema = z.object({
  runId: CanonicalChatRunIdSchema,
  status: z.enum([
    "accepted",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "completed",
    "failed",
    "aborted",
  ]),
  driverKind: CanonicalProviderDriverKindSchema,
  instanceId: CanonicalProviderInstanceIdSchema,
  model: referenceId(160),
  startedAt: IsoTimestampSchema.optional(),
  completedAt: IsoTimestampSchema.optional(),
}).strict();

export const CanonicalChatProviderBindingSchema = z.object({
  driverKind: CanonicalProviderDriverKindSchema,
  instanceId: CanonicalProviderInstanceIdSchema,
  lockedAtTurnId: CanonicalChatTurnIdSchema,
}).strict();

export const CanonicalChatActiveRunProjectionSchema = z.object({
  runId: CanonicalChatRunIdSchema,
  turnId: CanonicalChatTurnIdSchema,
  status: z.enum(["accepted", "running", "waiting_for_approval", "waiting_for_input"]),
}).strict();

export const CanonicalChatSummarySchema = CanonicalChatSchema.extend({
  project: CanonicalChatProjectProjectionSchema.optional(),
  providerBinding: CanonicalChatProviderBindingSchema.optional(),
  activeRun: CanonicalChatActiveRunProjectionSchema.optional(),
}).strict();

const CanonicalChatInspectorChangeFileSchema = z.object({
  resource: CanonicalChatResourceReferenceSchema.refine(
    (resource) => resource.kind === "file" || resource.kind === "folder",
    { message: "Changes can reference only files or folders" },
  ),
  changeKind: z.enum(["created", "updated", "deleted", "renamed"]),
}).strict();

const CanonicalChatInspectorAvailableChangesSchema = z.object({
  availability: z.literal("available"),
  turnId: CanonicalChatTurnIdSchema,
  changedFileCount: z.number().int().min(0).max(10_000),
  additions: z.number().int().min(0).max(1_000_000),
  deletions: z.number().int().min(0).max(1_000_000),
  partial: z.boolean(),
  files: z.array(CanonicalChatInspectorChangeFileSchema).max(500),
}).strict().refine((changes) => changes.files.length <= changes.changedFileCount, {
  message: "Projected files cannot exceed the changed-file count",
  path: ["files"],
});

const CanonicalChatInspectorChangesSchema = z.discriminatedUnion("availability", [
  CanonicalChatInspectorAvailableChangesSchema,
  z.object({
    availability: z.literal("unavailable"),
    reason: z.enum(["not_supported", "not_ready", "run_incomplete", "history_only"]),
  }).strict(),
]);

export const CanonicalChatInspectorProjectionSchema = z.object({
  chatId: CanonicalChatIdSchema,
  context: z.object({
    project: CanonicalChatProjectProjectionSchema.optional(),
    executionRoot: CanonicalChatExecutionRootRefSchema.optional(),
  }).strict(),
  run: CanonicalChatInspectorRunSchema.optional(),
  files: z.array(CanonicalChatResourceReferenceSchema).max(500),
  terminals: z.array(CanonicalChatResourceReferenceSchema.refine(
    (resource) => resource.kind === "terminal_session",
    { message: "Terminal projections require terminal resources" },
  )).max(50),
  changes: CanonicalChatInspectorChangesSchema,
}).strict().superRefine((inspector, ctx) => {
  const projectId = inspector.context.project?.projectId;
  const rootProjectId = inspector.context.executionRoot?.projectId;
  if (projectId !== undefined && rootProjectId !== undefined && projectId !== rootProjectId) {
    ctx.addIssue({
      code: "custom",
      path: ["context", "executionRoot", "projectId"],
      message: "Execution root must belong to the projected Project",
    });
  }
});

export const CanonicalChatSnapshotSchema = z.object({
  chat: CanonicalChatSummarySchema,
  messages: z.array(CanonicalChatMessageSchema).max(200),
  turns: z.array(CanonicalChatTurnSchema).max(100),
  runs: z.array(CanonicalChatRunSchema).max(100),
  activities: z.array(CanonicalChatRunActivitySchema).max(500),
  inspector: CanonicalChatInspectorProjectionSchema,
}).strict().superRefine((snapshot, ctx) => {
  const chatId = snapshot.chat.id;
  for (const [key, values] of [
    ["messages", snapshot.messages],
    ["turns", snapshot.turns],
    ["runs", snapshot.runs],
    ["activities", snapshot.activities],
  ] as const) {
    values.forEach((value, index) => {
      if (value.chatId !== chatId) {
        ctx.addIssue({ code: "custom", path: [key, index, "chatId"], message: "Chat mismatch" });
      }
    });
  }
  if (snapshot.inspector.chatId !== chatId) {
    ctx.addIssue({ code: "custom", path: ["inspector", "chatId"], message: "Chat mismatch" });
  }
  const sequences = snapshot.messages.map((message) => message.seq);
  if (new Set(sequences).size !== sequences.length
    || sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1]!)) {
    ctx.addIssue({ code: "custom", path: ["messages"], message: "Message sequence must be unique and ordered" });
  }
  const activeRun = snapshot.chat.activeRun;
  if (activeRun !== undefined
    && !snapshot.runs.some((run) => run.id === activeRun.runId && run.turnId === activeRun.turnId)) {
    ctx.addIssue({ code: "custom", path: ["chat", "activeRun"], message: "Active Run is not in the snapshot" });
  }
});

export type CanonicalChatInvocation = z.infer<typeof CanonicalChatInvocationSchema>;
export type CanonicalChatResourceReference = z.infer<typeof CanonicalChatResourceReferenceSchema>;
export type CanonicalChatProjectProjection = z.infer<typeof CanonicalChatProjectProjectionSchema>;
export type CanonicalChatExecutionRootRef = z.infer<typeof CanonicalChatExecutionRootRefSchema>;
export type CanonicalChatInspectorProjection = z.infer<typeof CanonicalChatInspectorProjectionSchema>;
export type CanonicalChatProviderBinding = z.infer<typeof CanonicalChatProviderBindingSchema>;
export type CanonicalChatSummary = z.infer<typeof CanonicalChatSummarySchema>;
export type CanonicalChatSnapshot = z.infer<typeof CanonicalChatSnapshotSchema>;
