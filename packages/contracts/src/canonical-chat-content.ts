import { z } from "zod/v4";
import { CanonicalChatDetailResponseSchema, CanonicalChatRecordSchema, CanonicalChatStreamEventSchema, CanonicalChatStreamServerFrameSchema } from "#canonical-chat-api";
import { CanonicalChatMessageSchema } from "#canonical-chat";
import type { CanonicalChatSafeError } from "#canonical-chat";
export { canonicalChatApprovals, canonicalChatApprovalOutcome, type CanonicalChatApprovalView } from "#canonical-chat-approvals";

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

/** Older strict Chat parsers cannot read new funding error codes. */
export const ChatFundingWireVersionSchema = z.enum(["0", "1"]).default("0");
export function chatFundingVersionUrl(path: string): string {
  if (/[?&]fundingVersion=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}fundingVersion=1`;
}

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
  agent_full_access_required: "This Agent's runtime requires Full access. Enable it for this request or choose a different Agent model.",
  run_not_found: "The previous Run no longer exists. Refresh and try again.",
  run_not_resumable: "The previous Run cannot be resumed. Start a new message.",
  run_unavailable: "The agent Run is temporarily unavailable. Try again.",
  history_window_required: "This Chat needs more recent history before it can continue. Refresh and try again.",
  migration_in_progress: "This Chat is being upgraded. Wait a moment and try again.",
  run_failed: "The agent could not complete its reply. Try again or check Agents & providers.",
  insufficient_credit: "There is not enough credit available for this Chat. Check Matrix AI credit in Settings or choose another connection.",
  credit_reserved: "Chat credit is currently reserved for earlier AI requests. Check Matrix AI in Settings or choose another connection.",
  budget_exceeded: "The monthly AI budget has been reached. Check Matrix AI in Settings or choose another connection.",
  resource_unavailable: "One of the referenced files or resources is unavailable.",
  authorization_failed: "You do not have permission to send this message.",
  service_unavailable: "Chat service is temporarily unavailable. Try again.",
};

const AGENT_FAILURE_COPY = {
  authentication_required: { code: "provider_unavailable", safeMessage: "The agent connection is signed out or its login is no longer valid. Open Agents & providers and sign in again on the selected computer." },
  usage_limit: { code: "run_failed", safeMessage: "The selected connection has reached its usage limit. Wait for your allowance to reset or choose another connection." },
  credit_required: { code: "provider_unavailable", safeMessage: "The selected connection has no usable credit. Check its billing or choose another connection." },
  billing_required: { code: "provider_unavailable", safeMessage: "The selected connection needs billing attention. Check its credit or payment settings, or choose another connection." },
} as const;

/** Reviewed details use existing codes, so strict older clients can still load the Chat. */
export function canonicalAgentFailure(reason: unknown): CanonicalChatSafeError | undefined {
  if (typeof reason !== "string" || !Object.hasOwn(AGENT_FAILURE_COPY, reason)) return undefined;
  return { ...AGENT_FAILURE_COPY[reason as keyof typeof AGENT_FAILURE_COPY], retryable: false,
    recoveryActions: reason === "authentication_required" ? ["open_setup_terminal", "select_provider"] : ["select_provider"] };
}

export function canonicalChatSafeFailureReason(code: unknown, reviewedDetail?: unknown): string | undefined {
  for (const detail of Object.values(AGENT_FAILURE_COPY)) {
    if (code === detail.code && reviewedDetail === detail.safeMessage) return detail.safeMessage;
  }
  // Claude publishes a separately validated quota reset. Accept only this
  // closed copy template, never an arbitrary upstream safeMessage.
  if (code === "run_failed" && typeof reviewedDetail === "string") {
    if (reviewedDetail === "Your usage limit has been reached. Try again after your allowance resets.") return reviewedDetail;
    const match = /^Your usage limit has been reached\. Try again after (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\.$/.exec(reviewedDetail);
    if (match) {
      const timestamp = `${match[1]}T${match[2]}:00.000Z`;
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed) && new Date(parsed).toISOString() === timestamp) return reviewedDetail;
    }
  }
  return typeof code === "string" && Object.hasOwn(CANONICAL_CHAT_FAILURE_COPY, code)
    ? CANONICAL_CHAT_FAILURE_COPY[code as CanonicalChatSafeError["code"]]
    : undefined;
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
      ...(run.status === "failed" && runError?.type === "run.error" ? { code: runError.error.code } : {}),
      beforeMessageId: inputs[index + 1]?.turn.inputMessageId,
      text: run.status === "failed"
        ? canonicalChatSafeFailureReason(runError?.type === "run.error" ? runError.error.code : undefined,
          runError?.type === "run.error" ? runError.error.safeMessage : undefined)
          ?? canonicalChatSafeFailureReason("run_failed")!
        : "Agent work stopped.",
      timestamp: Date.parse(run.completedAt ?? run.updatedAt),
    }];
  });
}

export { buildCanonicalChatInputAnswer, canonicalChatInputs, type CanonicalChatInputView } from "#canonical-chat-inputs";
