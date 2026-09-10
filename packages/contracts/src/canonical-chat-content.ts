import { z } from "zod/v4";
import { CanonicalChatDetailResponseSchema, CanonicalChatListResponseSchema, CanonicalChatRecordSchema, CanonicalChatStreamEventSchema, CanonicalChatStreamServerFrameSchema } from "#canonical-chat-api";
import { CanonicalChatMessageSchema } from "#canonical-chat";
import type { CanonicalChatSafeError } from "#canonical-chat";
export { canonicalChatApprovals, type CanonicalChatApprovalView } from "#canonical-chat-approvals";

// Opt-in v2 frames. Never send these to an unversioned notification client.
export const CanonicalChatContentSchema = z.object({
  record: CanonicalChatRecordSchema,
  messageDelta: z.object({
    // Metadata plus ONLY the appended text, not the accumulated reply.
    // A delta may be only whitespace even though a complete message may not.
    message: CanonicalChatMessageSchema.safeExtend({
      parts: z.array(z.object({
        type: z.literal("text"),
        text: z.string().min(1).max(32_000)
          .refine((text) => new TextEncoder().encode(text).byteLength <= 96 * 1024),
      }).strict()).length(1),
    }).refine((m) => m.role === "assistant"
      && m.state === "pending" && m.parts.length === 1 && m.parts[0]?.type === "text"),
    partIndex: z.number().int().min(0).max(63),
    offset: z.number().int().min(0).max(1_000_000),
  }).strict().optional(),
  messages: CanonicalChatDetailResponseSchema.shape.messages.optional(),
  turns: CanonicalChatDetailResponseSchema.shape.turns.optional(),
  runs: CanonicalChatDetailResponseSchema.shape.runs.optional(),
  activities: CanonicalChatDetailResponseSchema.shape.activities.optional(),
  removedActivityIds: z.array(z.string().min(1).max(160)).max(500).optional(),
  queuedTurns: CanonicalChatDetailResponseSchema.shape.queuedTurns,
  terminalSessionIds: CanonicalChatDetailResponseSchema.shape.terminalSessionIds,
}).strict();

export const CanonicalChatContentFrameSchema = z.object({
  type: z.literal("chat.content"),
  event: CanonicalChatStreamEventSchema,
  content: CanonicalChatContentSchema,
}).strict().superRefine((frame, ctx) => {
  if (frame.content.record.chat.id !== frame.event.chatId
    || frame.content.record.chat.revision !== frame.event.revision) {
    ctx.addIssue({ code: "custom", message: "Content revision mismatch" });
  }
  const entities = [
    ...(frame.content.messageDelta ? [frame.content.messageDelta.message] : []),
    ...(frame.content.messages ?? []), ...(frame.content.turns ?? []),
    ...(frame.content.runs ?? []), ...(frame.content.activities ?? []),
    ...(frame.content.queuedTurns ?? []),
  ];
  if (entities.some((entity) => entity.chatId !== frame.event.chatId)) {
    ctx.addIssue({ code: "custom", message: "Content Chat mismatch" });
  }
});
export type CanonicalChatContent = z.infer<typeof CanonicalChatContentSchema>;
export type CanonicalChatContentFrame = z.infer<typeof CanonicalChatContentFrameSchema>;
export const CanonicalChatTransportFrameSchema = z.union([CanonicalChatStreamServerFrameSchema, CanonicalChatContentFrameSchema]);
export type CanonicalChatTransportFrame = z.infer<typeof CanonicalChatTransportFrameSchema>;

/** Reviewed renderer copy keyed only by the bounded wire error code. */
const CANONICAL_CHAT_FAILURE_COPY: Record<CanonicalChatSafeError["code"], string> = {
  chat_not_found: "This Chat no longer exists. Start a new Chat.",
  chat_busy: "This Chat already has an active response. Wait for it to finish or stop it.",
  chat_conflict: "This Chat changed before the message was sent. Refresh and try again.",
  chat_unavailable: "This Chat is temporarily unavailable. Try again.",
  project_required: "Choose a Project before sending this message.",
  project_unavailable: "The selected Project is unavailable. Choose another Project.",
  provider_unavailable: "This connection is currently unavailable. Open Agents & providers to check it.",
  provider_instance_locked: "This Chat is locked to another provider. Use that provider or start a new Chat.",
  model_unavailable: "The selected model is unavailable. Choose another model.",
  capability_mismatch: "The selected provider does not support one of the requested options or attachments.",
  run_not_found: "The previous Run no longer exists. Refresh and try again.",
  run_not_resumable: "The previous Run cannot be resumed. Start a new message.",
  run_unavailable: "The agent Run is temporarily unavailable. Try again.",
  history_window_required: "This Chat needs more recent history before it can continue. Refresh and try again.",
  migration_in_progress: "This Chat is being upgraded. Wait a moment and try again.",
  run_failed: "The agent could not complete its reply. Try again or check Agents & providers.",
  resource_unavailable: "One of the referenced files or resources is unavailable.",
  authorization_failed: "You do not have permission to send this message.",
  service_unavailable: "Chat service is temporarily unavailable. Try again.",
};

export function canonicalChatSafeFailureReason(code: unknown): string | undefined {
  return typeof code === "string" && Object.hasOwn(CANONICAL_CHAT_FAILURE_COPY, code)
    ? CANONICAL_CHAT_FAILURE_COPY[code as CanonicalChatSafeError["code"]]
    : undefined;
}

function upsert<T extends { id: string }>(current: T[], incoming: T[] = []): T[] {
  const result = [...current];
  for (const item of incoming) {
    const index = result.findIndex((existing) => existing.id === item.id);
    if (index < 0) result.push(item);
    else result[index] = item;
  }
  return result;
}

/** null means a gap: recover a snapshot, never guess missing text or ordering. */
export function applyCanonicalChatContent(
  detail: z.infer<typeof CanonicalChatDetailResponseSchema>,
  frame: CanonicalChatContentFrame,
): z.infer<typeof CanonicalChatDetailResponseSchema> | null {
  if (detail.record.chat.id !== frame.event.chatId
    || detail.record.chat.revision >= frame.event.revision) return detail;
  if (detail.record.chat.revision + 1 !== frame.event.revision) return null;
  const content = frame.content;
  let messages = upsert(detail.messages, content.messages);
  if (content.messageDelta) {
    const { message, partIndex, offset } = content.messageDelta;
    const delta = message.parts[0];
    if (delta?.type !== "text") return null;
    const existing = messages.find((item) => item.id === message.id);
    if (!existing) {
      if (offset !== 0 || partIndex !== 0) return null;
      messages = upsert(messages, [message]);
    } else {
      if (existing.runId !== message.runId
        || existing.turnId !== message.turnId
        || existing.state !== "pending") return null;
      const parts = [...existing.parts];
      const part = parts[partIndex];
      if (partIndex === parts.length && offset === 0) parts.push(delta);
      else if (part?.type === "text" && part.text.length === offset) {
        parts[partIndex] = { type: "text", text: part.text + delta.text };
      } else return null;
      messages = upsert(messages, [{ ...existing, parts }]);
    }
  }
  const sortedMessages = messages.sort((a, b) => a.seq - b.seq);
  const windowMessages = sortedMessages.slice(-200);
  const turnIds = new Set(windowMessages.flatMap((message) => message.turnId ? [message.turnId] : []));
  const turns = upsert(detail.turns, content.turns).filter((turn) => turnIds.has(turn.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
  const runIds = new Set(windowMessages.flatMap((message) => message.runId ? [message.runId] : []));
  const visibleTurnIds = new Set(turns.map((turn) => turn.id));
  const runs = upsert(detail.runs, content.runs)
    .filter((run) => runIds.has(run.id) || visibleTurnIds.has(run.turnId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
  const visibleRunIds = new Set(runs.map((run) => run.id));
  const removedActivityIds = new Set(content.removedActivityIds ?? []);
  return {
    ...detail,
    record: content.record,
    messages: windowMessages,
    ...(messages.length > 200 ? { nextBeforeSeq: windowMessages[0]!.seq } : {}),
    turns,
    runs,
    activities: upsert(
      detail.activities.filter((activity) => !removedActivityIds.has(activity.id)),
      content.activities,
    ).filter((activity) => visibleRunIds.has(activity.runId))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.runId.localeCompare(b.runId)
        || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id)).slice(-500),
    ...(content.queuedTurns === undefined ? {} : { queuedTurns: content.queuedTurns }),
    ...(content.terminalSessionIds === undefined ? {} : { terminalSessionIds: content.terminalSessionIds }),
  };
}

/** Upsert a streamed list projection while refusing an older record. */
export function mergeCanonicalChatListRecord(
  list: z.infer<typeof CanonicalChatListResponseSchema>,
  record: z.infer<typeof CanonicalChatRecordSchema>,
) {
  const index = list.items.findIndex((item) => item.chat.id === record.chat.id);
  if (index >= 0 && list.items[index]!.chat.revision >= record.chat.revision) return list;
  const items = [...list.items];
  if (index < 0) items.unshift(record);
  else items[index] = record;
  return { ...list, items: items.slice(0, 100) };
}

/** Prefer the REST snapshot only when it satisfies the latest streamed revision fence. */
export function preferCanonicalChatDetailSnapshot(
  current: z.infer<typeof CanonicalChatDetailResponseSchema> | undefined,
  incoming: z.infer<typeof CanonicalChatDetailResponseSchema>,
  minimumRevision = 0,
): z.infer<typeof CanonicalChatDetailResponseSchema> | undefined {
  const incomingRevision = incoming.record.chat.revision;
  if (incomingRevision < minimumRevision) return current;
  if (current?.record.chat.id === incoming.record.chat.id
    && current.record.chat.revision > incomingRevision) return current;
  return incoming;
}

/** Shared terminal outcome derivation; renderers only adapt placement and styling. */
export function canonicalChatTerminalNotices(detail: z.infer<typeof CanonicalChatDetailResponseSchema>) {
  const inputs = detail.turns.map((turn) => ({ turn,
    message: detail.messages.find((message) => message.id === turn.inputMessageId),
  })).filter((input) => input.message !== undefined).sort((a, b) => a.message!.seq - b.message!.seq);
  return inputs.flatMap(({ turn }, index) => {
    const run = detail.runs.filter((candidate) => candidate.turnId === turn.id)
      .reduce<(typeof detail.runs)[number] | undefined>((latest, candidate) =>
        !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
    if (!run || (run.status !== "failed" && run.status !== "aborted")) return [];
    const runError = detail.activities.filter((activity) => activity.type === "run.error" && activity.runId === run.id)
      .reduce<(typeof detail.activities)[number] | undefined>((latest, activity) =>
        !latest || (activity.sequence ?? 0) >= (latest.sequence ?? 0) ? activity : latest, undefined);
    return [{ id: `${run.id}:terminal`, runId: run.id,
      beforeMessageId: inputs[index + 1]?.turn.inputMessageId,
      text: run.status === "failed"
        ? canonicalChatSafeFailureReason(runError?.type === "run.error" ? runError.error.code : undefined)
          ?? canonicalChatSafeFailureReason("run_failed")!
        : "Agent work stopped.",
      timestamp: Date.parse(run.completedAt ?? run.updatedAt),
    }];
  });
}

export { buildCanonicalChatInputAnswer, canonicalChatInputs, type CanonicalChatInputView } from "#canonical-chat-inputs";
