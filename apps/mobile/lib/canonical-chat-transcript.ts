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

export function buildTranscript(detail: CanonicalChatDetailResponse | null): TranscriptMessage[] {
  if (!detail) return [];
  const runsById = new Map(detail.runs.map((run) => [run.id, run]));
  const ordered = [...detail.messages].sort((left, right) => left.seq - right.seq);

  const transcript = ordered.map((message): TranscriptMessage => {
    const run = message.runId ? runsById.get(message.runId) : undefined;
    return {
      id: message.id,
      role: message.role,
      text: messageText(message),
      toolCalls: messageToolCalls(message),
      elapsedSeconds: message.role === "assistant" ? runElapsedSeconds(run) : undefined,
      isRunning: run ? !TERMINAL_RUN_STATUSES.has(run.status) : false,
      createdAt: Date.parse(message.createdAt),
    };
  });

  // Newest-first, matching the inverted transcript FlatList.
  return transcript.reverse();
}
