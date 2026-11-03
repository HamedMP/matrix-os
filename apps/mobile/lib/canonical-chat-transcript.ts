import { canonicalChatToolActivities, canonicalReviewedAgentFailure, canonicalAssistantOutputMessages, type CanonicalToolActivity } from "@matrix-os/contracts";
import { canonicalChatInputs, type CanonicalChatInputView, canonicalChatApprovals, canonicalChatTerminalNotices, type CanonicalChatApprovalView } from "@matrix-os/contracts";
import type {
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
  CanonicalChatRun,
} from "@matrix-os/contracts";

// By relative path: the repository's own tests load this module too, and
// there "@/" is the web shell, not this app.
import {
  chatAttachmentUploadPath,
  type ComposerAttachment,
  type SentAttachmentUris,
  type TranscriptAttachment,
} from "./chat-attachments";

export type TranscriptActivityState = CanonicalToolActivity["state"];
export type TranscriptActivity = CanonicalToolActivity;

export interface TranscriptToolCall {
  id: string;
  label: string;
}

/** How a turn ended that did not finish. */
export interface TranscriptNotice {
  tone: "failed" | "stopped";
  /**
   * The turn a Retry runs again. Set only for the chat's latest turn, and
   * only when its failure says that trying again can help: the rule Electron
   * Desktop applies, and the only turn the computer runs again.
   */
  retryTurnId?: string;
}

export interface TranscriptMessage {
  input?: CanonicalChatInputView;
  approval?: CanonicalChatApprovalView;
  /** Set on the line that says how a turn ended when it did not finish. */
  notice?: TranscriptNotice;
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** The photos and files sent with the message. Left out when there are none. */
  attachments?: TranscriptAttachment[];
  toolCalls: TranscriptToolCall[];
  /** Run activities (reasoning, plan, command, tool calls in progress, ...) for this message's run. */
  activities: TranscriptActivity[];
  /** Only resolvable when the message is tied to a run (assistant turns). */
  elapsedSeconds?: number;
  isRunning: boolean;
  createdAt: number;
  /**
   * A message sent from this phone that the computer does not have yet: on
   * its way, or not sent. Left out once it has been admitted, and for every
   * message read from the computer.
   */
  delivery?: "sending" | "failed";
  /** A message that was not sent cannot be sent again as it is, as when the chosen model does not read what is attached. */
  retryBlocked?: boolean;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);

function messageText(message: CanonicalChatMessage): string {
  return message.parts
    .map((part) => {
      switch (part.type) {
        case "text": return part.text;
        case "summary": return part.text;
        case "status": return part.detail ? `${part.label}: ${part.detail}` : part.label;
        default: return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

function messageAttachments(message: CanonicalChatMessage): TranscriptAttachment[] {
  const attachments: TranscriptAttachment[] = [];
  for (const part of message.parts) {
    if (part.type !== "attachment_reference") continue;
    attachments.push({
      id: part.attachmentId,
      label: part.label,
      kind: part.kind === "image" ? "image" : "file",
      ...(part.ownerReference ? { path: part.ownerReference } : {}),
    });
  }
  return attachments;
}

function messageToolCalls(message: CanonicalChatMessage): TranscriptToolCall[] {
  const calls: TranscriptToolCall[] = [];
  for (const part of message.parts) {
    if (part.type === "tool_request") {
      calls.push({ id: part.toolCallId, label: part.label });
    }
  }
  return calls;
}

function runElapsedSeconds(run: CanonicalChatRun | undefined): number | undefined {
  if (!run?.startedAt) return undefined;
  const started = Date.parse(run.startedAt);
  const ended = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  return Math.max(0, Math.round((ended - started) / 1000));
}

/** A terminal child-only run still needs an accessible work toggle. */
export function transcriptWorkLabel(message: TranscriptMessage): string | null {
  if (message.isRunning) return "Working…";
  if (message.elapsedSeconds != null) return `Worked ${message.elapsedSeconds}s`;
  return message.activities.length || message.toolCalls.length ? "Agent activity" : null;
}

/** The turn the computer would run again: the one with the latest base message, as the gateway orders them. */
function latestTurnId(detail: CanonicalChatDetailResponse): string | undefined {
  return detail.turns.reduce<CanonicalChatDetailResponse["turns"][number] | undefined>((latest, turn) => (
    latest === undefined
      || turn.baseMessageSeq > latest.baseMessageSeq
      || (turn.baseMessageSeq === latest.baseMessageSeq && turn.createdAt > latest.createdAt)
      ? turn
      : latest
  ), undefined)?.id;
}

/**
 * The turn of a failed run that a Retry may run again, or undefined. The
 * computer's reported error has to call itself retryable and list a retry
 * as its recovery, and a failure whose reviewed copy says otherwise (such as
 * a timeout, where the agent may have done part of the work) is not retried.
 */
function retryableTurnId(
  detail: CanonicalChatDetailResponse,
  run: CanonicalChatRun | undefined,
  latestTurn: string | undefined,
): string | undefined {
  if (!run || run.status !== "failed" || run.turnId !== latestTurn) return undefined;
  const runError = detail.activities
    .filter((activity) => activity.type === "run.error" && activity.runId === run.id)
    .reduce<CanonicalChatDetailResponse["activities"][number] | undefined>((latest, activity) => (
      !latest || (activity.sequence ?? 0) >= (latest.sequence ?? 0) ? activity : latest
    ), undefined);
  if (runError?.type !== "run.error") return undefined;
  const { error } = runError;
  const reviewed = canonicalReviewedAgentFailure(error.code, error.safeMessage);
  return error.retryable && (reviewed?.retryable ?? true) && error.recoveryActions?.includes("retry")
    ? run.turnId
    : undefined;
}

export function buildTranscript(detail: CanonicalChatDetailResponse | null): TranscriptMessage[] {
  if (!detail) return [];
  detail = { ...detail, messages: canonicalAssistantOutputMessages(detail.messages) };
  const runsById = new Map(detail.runs.map((run) => [run.id, run]));
  const ordered = [...detail.messages].sort((left, right) => left.seq - right.seq);

  // Activities are run-level, but a run can produce more than one assistant
  // message (split by tool calls); attach them to the run's last
  // (highest-seq) assistant message, matching where its tool calls already
  // tend to surface.
  const lastAssistantSeqByRun = new Map<string, number>();
  const runIdsWithAssistantMessage = new Set<string>();
  for (const message of ordered) {
    if (message.role !== "assistant" || !message.runId) continue;
    runIdsWithAssistantMessage.add(message.runId);
    const current = lastAssistantSeqByRun.get(message.runId) ?? -1;
    if (message.seq > current) lastAssistantSeqByRun.set(message.runId, message.seq);
  }

  const transcript = ordered.map((message): TranscriptMessage => {
    const run = message.runId ? runsById.get(message.runId) : undefined;
    const isRunsLastAssistantMessage = message.runId !== undefined
      && lastAssistantSeqByRun.get(message.runId) === message.seq;
    const attachments = messageAttachments(message);
    return {
      id: message.id,
      role: message.role,
      text: messageText(message),
      ...(attachments.length > 0 ? { attachments } : {}),
      toolCalls: messageToolCalls(message),
      activities: run && isRunsLastAssistantMessage ? canonicalChatToolActivities(run, detail.activities) : [],
      elapsedSeconds: message.role === "assistant" ? runElapsedSeconds(run) : undefined,
      isRunning: run ? !TERMINAL_RUN_STATUSES.has(run.status) : false,
      createdAt: Date.parse(message.createdAt),
    };
  }).reverse(); // Newest-first, matching the inverted transcript FlatList.

  // A run can be actively working (tool calls, reasoning) for a while before
  // its first assistant text delta ever lands -- without a placeholder there
  // is nothing to render at all during that window, so a fast final response
  // looks like it appeared in one shot.
  for (const run of detail.runs) {
    if (runIdsWithAssistantMessage.has(run.id)) continue;
    const activities = canonicalChatToolActivities(run, detail.activities);
    const isRunning = !TERMINAL_RUN_STATUSES.has(run.status);
    if (!isRunning && !activities.some((activity) => activity.subagent)) continue;
    const createdAt = Date.parse(run.startedAt ?? run.createdAt);
    const index = transcript.findIndex(message => message.createdAt <= createdAt);
    transcript.splice(index < 0 ? transcript.length : index, 0, {
      id: `run-placeholder-${run.id}`,
      role: "assistant",
      text: "",
      toolCalls: [],
      activities,
      elapsedSeconds: run.completedAt ? runElapsedSeconds(run) : undefined,
      isRunning,
      createdAt,
    });
  }

  for (const approval of canonicalChatApprovals(detail)) {
    const existing = transcript.find(message => message.id === approval.id);
    if (existing) {
      existing.approval = approval;
      continue;
    }
    const index = approval.beforeMessageId ? transcript.findIndex(message => message.id === approval.beforeMessageId) : -1;
    transcript.splice(index < 0 ? 0 : index + 1, 0, {
      id: approval.id, role: "system", text: approval.title, toolCalls: [], activities: [],
      isRunning: false, createdAt: approval.timestamp, approval,
    });
  }
  for (const input of canonicalChatInputs(detail)) {
    const index = input.beforeMessageId ? transcript.findIndex(message => message.id === input.beforeMessageId) : -1;
    transcript.splice(index < 0 ? 0 : index + 1, 0, {
      id: input.id, role: "system", text: input.title, toolCalls: [], activities: [],
      isRunning: false, createdAt: input.timestamp, input,
    });
  }
  const latestTurn = latestTurnId(detail);
  for (const notice of canonicalChatTerminalNotices(detail)) {
    const index = notice.beforeMessageId ? transcript.findIndex((message) => message.id === notice.beforeMessageId) : -1;
    const run = runsById.get(notice.runId);
    const stopped = run?.status === "aborted";
    const retryTurnId = stopped ? undefined : retryableTurnId(detail, run, latestTurn);
    transcript.splice(index < 0 ? 0 : index + 1, 0, {
      id: notice.id, role: "system", text: notice.text, toolCalls: [], activities: [],
      isRunning: false, createdAt: notice.timestamp,
      notice: { tone: stopped ? "stopped" : "failed", ...(retryTurnId ? { retryTurnId } : {}) },
    });
  }
  return transcript;
}

/** A message the user just sent, shown in the transcript before the server confirms it. */
export interface OptimisticUserMessage {
  /** Transcript list key; distinct from any server message id. */
  id: string;
  /** The chat it was sent in, or null while the draft's chat has not been created yet. */
  chatId: string | null;
  /** Empty when the message is attachments alone. */
  text: string;
  /** What was sent with it, still on the phone. */
  attachments?: readonly ComposerAttachment[];
  /** The `clientRequestId` its turn is admitted with; the server echoes it on the turn. */
  turnRequestId: string;
  createdAt: number;
  /** The server's id for it, known once the admission response arrives. */
  messageId?: string;
  /** Its send failed: it stays in the chat, marked as not sent, until it is sent again or taken back to the composer. */
  failed?: boolean;
  /** Its send failed and it cannot be sent again as it is. */
  retryBlocked?: boolean;
}

export function optimisticTranscriptMessage(optimistic: OptimisticUserMessage): TranscriptMessage {
  const attachments = (optimistic.attachments ?? []).map((attachment): TranscriptAttachment => {
    const path = chatAttachmentUploadPath(attachment);
    return {
      id: attachment.id,
      label: attachment.name,
      kind: attachment.kind,
      ...(path ? { path } : {}),
      localUri: attachment.uri,
    };
  });
  return {
    id: optimistic.id,
    role: "user",
    text: optimistic.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    toolCalls: [],
    activities: [],
    isRunning: false,
    createdAt: optimistic.createdAt,
    ...(optimistic.failed
      ? { delivery: "failed" as const, retryBlocked: optimistic.retryBlocked ?? false }
      : optimistic.messageId === undefined ? { delivery: "sending" as const } : {}),
  };
}

/**
 * True once `detail` holds the server's copy of an optimistic message, at
 * which point the transcript shows that copy instead.
 *
 * The copy can arrive over the event stream before the admission response
 * does, so it is recognised by the turn that carries this send's request id
 * rather than by the response alone. It is never matched by its text: the
 * same words from another client or participant are a different message.
 */
export function isOptimisticMessageDelivered(
  detail: CanonicalChatDetailResponse | null,
  optimistic: OptimisticUserMessage,
): boolean {
  if (!detail || detail.record.chat.id !== optimistic.chatId) return false;
  const turn = detail.turns.find((candidate) => candidate.clientRequestId === optimistic.turnRequestId);
  const messageId = turn?.inputMessageId ?? optimistic.messageId;
  return messageId !== undefined && detail.messages.some((message) => message.id === messageId);
}

/**
 * Shows each attachment that was sent from this phone from the phone's own
 * copy, so a photo does not blink out while the computer's copy of its message
 * loads. Returns `messages` itself when none of them has such an attachment.
 */
export function withLocalAttachments(messages: TranscriptMessage[], sent: SentAttachmentUris): TranscriptMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (!message.attachments?.some((attachment) => !attachment.localUri && attachment.path && sent[attachment.path])) {
      return message;
    }
    changed = true;
    return {
      ...message,
      attachments: message.attachments.map((attachment) => {
        const localUri = attachment.localUri ?? (attachment.path ? sent[attachment.path] : undefined);
        return localUri ? { ...attachment, localUri } : attachment;
      }),
    };
  });
  return changed ? next : messages;
}
