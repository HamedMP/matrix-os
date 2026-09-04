import type {
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
  CanonicalChatRun,
} from "@matrix-os/contracts";

export interface TranscriptToolCall {
  id: string;
  label: string;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCalls: TranscriptToolCall[];
  /** "reasoning" agent.activity entries from the message's run, if any. */
  reasoningNotes: TranscriptToolCall[];
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

function runElapsedSeconds(run: CanonicalChatRun | undefined): number | undefined {
  if (!run?.startedAt) return undefined;
  const started = Date.parse(run.startedAt);
  const ended = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  return Math.max(0, Math.round((ended - started) / 1000));
}

/**
 * Reasoning/thinking content lives in run activities (agent.activity, kind
 * "reasoning"), not in message parts. Group by runId, ordered by sequence,
 * so each run's notes can be attached to its assistant message.
 */
function reasoningNotesByRun(
  activities: CanonicalChatDetailResponse["activities"],
): Map<string, TranscriptToolCall[]> {
  const byRun = new Map<string, TranscriptToolCall[]>();
  const ordered = [...activities].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  for (const activity of ordered) {
    if (activity.type !== "agent.activity" || activity.kind !== "reasoning") continue;
    const label = activity.summary ?? activity.preview ?? activity.label;
    const existing = byRun.get(activity.runId) ?? [];
    existing.push({ id: activity.activityId, label });
    byRun.set(activity.runId, existing);
  }
  return byRun;
}

export function buildTranscript(detail: CanonicalChatDetailResponse | null): TranscriptMessage[] {
  if (!detail) return [];
  const runsById = new Map(detail.runs.map((run) => [run.id, run]));
  const ordered = [...detail.messages].sort((left, right) => left.seq - right.seq);
  const reasoningByRun = reasoningNotesByRun(detail.activities);

  // Reasoning notes are run-level, but a run can produce more than one
  // assistant message (split by tool calls); attach them to the run's last
  // (highest-seq) assistant message, matching where the run's tool calls
  // already tend to surface.
  const lastAssistantSeqByRun = new Map<string, number>();
  for (const message of ordered) {
    if (message.role !== "assistant" || !message.runId) continue;
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
      toolCalls: messageToolCalls(message),
      reasoningNotes: message.runId && isRunsLastAssistantMessage
        ? (reasoningByRun.get(message.runId) ?? [])
        : [],
      elapsedSeconds: message.role === "assistant" ? runElapsedSeconds(run) : undefined,
      isRunning: run ? !TERMINAL_RUN_STATUSES.has(run.status) : false,
      createdAt: Date.parse(message.createdAt),
    };
  });

  // Newest-first, matching the inverted transcript FlatList.
  return transcript.reverse();
}
