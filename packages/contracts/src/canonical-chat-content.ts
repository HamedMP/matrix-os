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
  provider_unavailable: "Connection unavailable. Check Agents & providers.",
  provider_instance_locked: "This Chat is locked to another provider. Use that provider or start a new Chat.",
  model_unavailable: "The selected model is unavailable. Choose another model.",
  capability_mismatch: "The selected provider does not support one of the requested options or attachments.",
  agent_full_access_required: "This Agent's runtime requires Full access. Enable it for this request or choose a different Agent model.",
  run_not_found: "The previous Run no longer exists. Refresh and try again.",
  run_not_resumable: "The previous Run cannot be resumed. Start a new message.",
  run_unavailable: "The agent Run is temporarily unavailable. Try again.",
  history_window_required: "This Chat needs more recent history before it can continue. Refresh and try again.",
  migration_in_progress: "This Chat is being upgraded. Wait a moment and try again.",
  run_failed: "The agent could not finish. Try again.",
  insufficient_credit: "Not enough Matrix AI credit. Add credit in Settings.",
  credit_reserved: "Credit is reserved by other requests. Wait or switch connection.",
  budget_exceeded: "Monthly AI budget reached. Adjust it in Settings.",
  resource_unavailable: "One of the referenced files or resources is unavailable.",
  authorization_failed: "You do not have permission to send this message.",
  service_unavailable: "Chat service is temporarily unavailable. Try again.",
};

type AgentFailureDefinition = {
  code: CanonicalChatSafeError["code"];
  safeMessage: string;
  legacyMessage?: string;
  retryable?: boolean;
  recoveryActions?: CanonicalChatSafeError["recoveryActions"];
};

const AGENT_FAILURE_COPY = {
  authentication_required: { code: "provider_unavailable", safeMessage: "Sign-in required. Reconnect in Agents & providers on this computer.", legacyMessage: "The agent connection is signed out or its login is no longer valid. Open Agents & providers and sign in again on the selected computer." },
  usage_limit: { code: "run_failed", safeMessage: "Usage limit reached. Wait for reset or switch connection.", legacyMessage: "The selected connection has reached its usage limit. Wait for your allowance to reset or choose another connection." },
  credit_required: { code: "provider_unavailable", safeMessage: "No usable agent credit. Check billing or switch connection.", legacyMessage: "The selected connection has no usable credit. Check its billing or choose another connection." },
  billing_required: { code: "provider_unavailable", safeMessage: "Billing needs attention. Check billing or switch connection.", legacyMessage: "The selected connection needs billing attention. Check its credit or payment settings, or choose another connection." },
  rate_limited: { code: "service_unavailable", safeMessage: "Too many requests. Wait a moment and retry.", retryable: true, recoveryActions: ["retry"], legacyMessage: "Requests are temporarily rate limited. Wait a moment and try again." },
  execution_timeout: { code: "run_failed", safeMessage: "The agent timed out. Check progress before trying again.", retryable: false, recoveryActions: [] },
  request_timeout: { code: "service_unavailable", safeMessage: "The agent timed out. Try again.", retryable: true, recoveryActions: ["retry"], legacyMessage: "Claude took too long to respond. Try the Run again." },
  connection_failed: { code: "service_unavailable", safeMessage: "Connection lost. Reconnect or try again.", retryable: true, recoveryActions: ["retry"] },
  service_busy: { code: "service_unavailable", safeMessage: "Service is busy. Try again shortly.", retryable: true, recoveryActions: ["retry"] },
  service_failed: { code: "service_unavailable", safeMessage: "Service failed. Try again shortly.", retryable: true, recoveryActions: ["retry"] },
  context_limit: { code: "run_not_resumable", safeMessage: "Conversation is too long. Start a new chat.", retryable: false, recoveryActions: ["start_new_chat"] },
  session_budget: { code: "run_failed", safeMessage: "Agent session budget reached. Check its budget settings.", retryable: false, recoveryActions: ["open_setup_terminal"] },
  permission_denied: { code: "authorization_failed", safeMessage: "Permission denied. Review access settings.", retryable: false, recoveryActions: ["open_setup_terminal"], legacyMessage: "Claude was blocked by its current permissions. Review the permission mode and try again." },
  model_unavailable: { code: "model_unavailable", safeMessage: "Model unavailable. Choose another model.", retryable: false, recoveryActions: ["select_provider"], legacyMessage: "The selected Claude model is unavailable. Choose another model and try again." },
  agent_unavailable: { code: "provider_unavailable", safeMessage: "Agent unavailable. Install or reconnect in Agents & providers.", retryable: false, recoveryActions: ["open_setup_terminal"], legacyMessage: "Claude is not available on this runtime. Open setup and install or reconnect Claude." },
  invalid_response: { code: "run_failed", safeMessage: "Invalid agent response. Try again.", retryable: true, recoveryActions: ["retry"], legacyMessage: "Claude returned an invalid response. Try the Run again." },
  policy_blocked: { code: "authorization_failed", safeMessage: "Request blocked by policy. Change your request.", retryable: false, recoveryActions: [] },
  invalid_request: { code: "capability_mismatch", safeMessage: "Request not supported. Change it and try again.", retryable: false, recoveryActions: [] },
  environment_failed: { code: "provider_unavailable", safeMessage: "Agent environment failed. Check setup or switch connection.", retryable: false, recoveryActions: ["open_setup_terminal"] },
  history_unavailable: { code: "run_not_resumable", safeMessage: "Conversation could not be restored. Start a new chat.", retryable: false, recoveryActions: ["start_new_chat"] },
} satisfies Record<string, AgentFailureDefinition>;

/** Reviewed details use existing codes, so strict older clients can still load the Chat. */
export function canonicalAgentFailure(reason: unknown): CanonicalChatSafeError | undefined {
  if (typeof reason !== "string" || !Object.hasOwn(AGENT_FAILURE_COPY, reason)) return undefined;
  const detail: AgentFailureDefinition = AGENT_FAILURE_COPY[reason as keyof typeof AGENT_FAILURE_COPY];
  return { code: detail.code, safeMessage: detail.safeMessage, retryable: detail.retryable ?? false,
    recoveryActions: detail.recoveryActions ?? (reason === "authentication_required"
      ? ["open_setup_terminal", "select_provider"] : ["select_provider"]) };
}

export function canonicalChatSafeFailureReason(code: unknown, reviewedDetail?: unknown): string | undefined {
  for (const detail of Object.values(AGENT_FAILURE_COPY)) {
    if (code === detail.code && (reviewedDetail === detail.safeMessage || ("legacyMessage" in detail && reviewedDetail === detail.legacyMessage))) return detail.safeMessage;
  }
  // Claude publishes a separately validated quota reset. Accept only this
  // closed copy template, never an arbitrary upstream safeMessage.
  if (code === "run_failed" && typeof reviewedDetail === "string") {
    if (reviewedDetail === "Your usage limit has been reached. Try again after your allowance resets."
      || reviewedDetail === "Usage limit reached. Wait for reset.") return "Usage limit reached. Wait for reset.";
    const match = /^(?:Your usage limit has been reached\. Try again after |Usage limit reached\. Resets )(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\.$/.exec(reviewedDetail);
    if (match) {
      const timestamp = `${match[1]}T${match[2]}:00.000Z`;
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed) && new Date(parsed).toISOString() === timestamp) return `Usage limit reached. Resets ${match[1]} ${match[2]} UTC.`;
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
