import { canonicalChatToolActivities, type CanonicalToolActivity } from "@matrix-os/contracts";
import { canonicalChatInputs, type CanonicalChatInputView, canonicalChatApprovals, canonicalChatTerminalNotices, type CanonicalChatApprovalView } from "@matrix-os/contracts";
import type {
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
  CanonicalChatRun,
} from "@matrix-os/contracts";

export type TranscriptActivityState = CanonicalToolActivity["state"];
export type TranscriptActivity = CanonicalToolActivity;

export interface TranscriptToolCall {
  id: string;
  label: string;
}

export interface TranscriptAttachment {
  id: string;
  kind: "image" | "file";
  label: string;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface TranscriptMessage {
  input?: CanonicalChatInputView;
  approval?: CanonicalChatApprovalView;
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  attachments: TranscriptAttachment[];
  toolCalls: TranscriptToolCall[];
  /** Run activities (reasoning, plan, command, tool calls in progress, ...) for this message's run. */
  activities: TranscriptActivity[];
  /** Only resolvable when the message is tied to a run (assistant turns). */
  elapsedSeconds?: number;
  isRunning: boolean;
  createdAt: number;
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

function messageToolCalls(message: CanonicalChatMessage): TranscriptToolCall[] {
  const calls: TranscriptToolCall[] = [];
  for (const part of message.parts) {
    if (part.type === "tool_request") {
      calls.push({ id: part.toolCallId, label: part.label });
    }
  }
  return calls;
}

function messageAttachments(message: CanonicalChatMessage): TranscriptAttachment[] {
  return message.parts.flatMap((part) => part.type === "attachment_reference" && part.ownerReference
    ? [{
        id: part.attachmentId,
        kind: part.kind === "image" ? "image" as const : "file" as const,
        label: part.label,
        path: part.ownerReference,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.sizeBytes === undefined ? {} : { sizeBytes: part.sizeBytes }),
      }]
    : []);
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

export function buildTranscript(detail: CanonicalChatDetailResponse | null): TranscriptMessage[] {
  if (!detail) return [];
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
    return {
      id: message.id,
      role: message.role,
      text: messageText(message),
      attachments: messageAttachments(message),
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
      attachments: [],
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
      id: approval.id, role: "system", text: approval.title, attachments: [], toolCalls: [], activities: [],
      isRunning: false, createdAt: approval.timestamp, approval,
    });
  }
  for (const input of canonicalChatInputs(detail)) {
    const index = input.beforeMessageId ? transcript.findIndex(message => message.id === input.beforeMessageId) : -1;
    transcript.splice(index < 0 ? 0 : index + 1, 0, {
      id: input.id, role: "system", text: input.title, attachments: [], toolCalls: [], activities: [],
      isRunning: false, createdAt: input.timestamp, input,
    });
  }
  for (const notice of canonicalChatTerminalNotices(detail)) {
    const index = notice.beforeMessageId ? transcript.findIndex((message) => message.id === notice.beforeMessageId) : -1;
    transcript.splice(index < 0 ? 0 : index + 1, 0, {
      id: notice.id, role: "system", text: notice.text, attachments: [], toolCalls: [], activities: [],
      isRunning: false, createdAt: notice.timestamp,
    });
  }
  return transcript;
}
