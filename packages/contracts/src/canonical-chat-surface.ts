import { z } from "zod/v4";
import {
  CanonicalChatMessageSchema,
  CanonicalChatInvocationSchema,
  CanonicalChatResourceKindSchema,
  CanonicalChatResourceReferenceSchema,
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
import {
  CanonicalChatExecutionRootRefSchema,
  canonicalReferenceId,
  canonicalSafeLabel,
} from "#canonical-chat-primitives";
import { IsoTimestampSchema } from "#contract-primitives";

export {
  CanonicalChatInvocationSchema,
  CanonicalChatResourceKindSchema,
  CanonicalChatResourceReferenceSchema,
} from "#canonical-chat";
export { CanonicalChatExecutionRootRefSchema } from "#canonical-chat-primitives";

export const CanonicalChatProjectProjectionSchema = z.object({
  projectId: canonicalReferenceId(160),
  name: canonicalSafeLabel(160, 640),
  kind: z.enum(["scratch", "github", "folder"]),
  repositoryLabel: canonicalSafeLabel(240, 960).optional(),
  status: z.enum(["ready", "unavailable"]),
}).strict();

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
  model: canonicalReferenceId(160),
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
}).strict().superRefine((chat, ctx) => {
  if (chat.providerBinding !== undefined
    && chat.currentSelection?.instanceId !== chat.providerBinding.instanceId) {
    ctx.addIssue({
      code: "custom",
      path: ["currentSelection", "instanceId"],
      message: "Bound Chat selection must use its immutable Provider Instance",
    });
  }
});

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
  if (activeRun !== undefined) {
    const referencedRun = snapshot.runs.find(
      (run) => run.id === activeRun.runId && run.turnId === activeRun.turnId,
    );
    if (referencedRun === undefined) {
      ctx.addIssue({ code: "custom", path: ["chat", "activeRun"], message: "Active Run is not in the snapshot" });
    } else if (referencedRun.status !== activeRun.status) {
      ctx.addIssue({ code: "custom", path: ["chat", "activeRun", "status"], message: "Active Run status mismatch" });
    }
  }
  const binding = snapshot.chat.providerBinding;
  snapshot.runs.forEach((run, index) => {
    if (binding === undefined
      || run.driverKind !== binding.driverKind
      || run.instanceId !== binding.instanceId) {
      ctx.addIssue({
        code: "custom",
        path: ["runs", index, "instanceId"],
        message: "Run must use the Chat's immutable Provider binding",
      });
    }
    if (!snapshot.turns.some((turn) => turn.id === run.turnId)) {
      ctx.addIssue({ code: "custom", path: ["runs", index, "turnId"], message: "Run Turn is not in the snapshot" });
    }
  });
  snapshot.turns.forEach((turn, index) => {
    const inputMessage = snapshot.messages.find((message) => message.id === turn.inputMessageId);
    if (inputMessage === undefined || (inputMessage.turnId !== undefined && inputMessage.turnId !== turn.id)) {
      ctx.addIssue({ code: "custom", path: ["turns", index, "inputMessageId"], message: "Turn input message is not in the snapshot" });
    }
  });
  snapshot.messages.forEach((message, index) => {
    if (message.turnId !== undefined && !snapshot.turns.some((turn) => turn.id === message.turnId)) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "turnId"], message: "Message Turn is not in the snapshot" });
    }
    if (message.runId !== undefined && !snapshot.runs.some((run) => run.id === message.runId)) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "runId"], message: "Message Run is not in the snapshot" });
    }
  });
  snapshot.activities.forEach((activity, index) => {
    if (!snapshot.runs.some((run) => run.id === activity.runId)) {
      ctx.addIssue({ code: "custom", path: ["activities", index, "runId"], message: "Activity Run is not in the snapshot" });
    }
  });
});

export type CanonicalChatProjectProjection = z.infer<typeof CanonicalChatProjectProjectionSchema>;
export type { CanonicalChatInvocation, CanonicalChatResourceReference } from "#canonical-chat";
export type { CanonicalChatExecutionRootRef } from "#canonical-chat-primitives";
export type CanonicalChatInspectorProjection = z.infer<typeof CanonicalChatInspectorProjectionSchema>;
export type CanonicalChatProviderBinding = z.infer<typeof CanonicalChatProviderBindingSchema>;
export type CanonicalChatSummary = z.infer<typeof CanonicalChatSummarySchema>;
export type CanonicalChatSnapshot = z.infer<typeof CanonicalChatSnapshotSchema>;
