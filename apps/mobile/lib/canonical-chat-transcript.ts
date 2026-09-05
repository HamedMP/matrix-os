import type {
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
  CanonicalChatRun,
  CanonicalChatRunActivity,
} from "@matrix-os/contracts";

export type TranscriptActivityState = "running" | "completed" | "partial" | "stopped" | "failed";

export interface TranscriptActivity {
  id: string;
  /** reasoning | plan | command | file_change | mcp_tool | dynamic_tool | delegation | web_search | image_inspection | phase | tool */
  kind: string;
  state: TranscriptActivityState;
  label: string;
  preview?: string;
  previewKind?: "command" | "path" | "text";
  detail?: string;
}

export interface TranscriptToolCall {
  id: string;
  label: string;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
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

function runElapsedSeconds(run: CanonicalChatRun | undefined): number | undefined {
  if (!run?.startedAt) return undefined;
  const started = Date.parse(run.startedAt);
  const ended = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  return Math.max(0, Math.round((ended - started) / 1000));
}

function activityState(
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "partial",
): TranscriptActivityState {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  if (status === "partial") return "partial";
  if (status === "completed") return "completed";
  return "running";
}

function isDuplicateProviderModelStatus(
  run: CanonicalChatRun,
  activity: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
): boolean {
  const namespaceSeparator = run.selection.model.indexOf(":");
  const model = namespaceSeparator >= 0 ? run.selection.model.slice(namespaceSeparator + 1) : run.selection.model;
  const expected = `Current model: ${model}`.toLowerCase();
  return activity.kind === "phase"
    && activity.label === "Working"
    && [activity.summary, activity.preview].some((value) => value?.trim().toLowerCase() === expected);
}

/**
 * Merges a run's tool.progress + tool.output + agent.activity entries into
 * one ordered, deduplicated activity list -- mirrors desktop's
 * runPresentation (canonical-chat-presentation.ts) so mobile shows the same
 * range of activity kinds (reasoning, plan, command, file_change, mcp_tool,
 * dynamic_tool, delegation, web_search, image_inspection) and real tool
 * calls in progress, not just "reasoning"/"command" labels.
 */
function runActivities(run: CanonicalChatRun, activities: CanonicalChatRunActivity[]): TranscriptActivity[] {
  const ordered = activities
    .filter((activity) => activity.runId === run.id)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));

  const toolProgress = new Map<string, Extract<CanonicalChatRunActivity, { type: "tool.progress" }>>();
  const agentActivities = new Map<string, Extract<CanonicalChatRunActivity, { type: "agent.activity" }>>();
  const toolOutput = new Map<string, string[]>();
  const order: Array<{ type: "tool" | "agent"; id: string }> = [];

  for (const activity of ordered) {
    if (activity.type === "tool.progress") {
      if (!toolProgress.has(activity.toolCallId)) order.push({ type: "tool", id: activity.toolCallId });
      toolProgress.set(activity.toolCallId, activity);
    } else if (activity.type === "agent.activity") {
      if (isDuplicateProviderModelStatus(run, activity)) continue;
      if (!agentActivities.has(activity.activityId)) order.push({ type: "agent", id: activity.activityId });
      agentActivities.set(activity.activityId, activity);
    } else if (activity.type === "tool.output") {
      const output = toolOutput.get(activity.toolCallId) ?? [];
      output.push(activity.text);
      toolOutput.set(activity.toolCallId, output);
    }
  }

  return order.flatMap(({ type, id }): TranscriptActivity[] => {
    if (type === "agent") {
      const activity = agentActivities.get(id);
      if (!activity) return [];
      const preview = activity.preview ?? activity.summary;
      return [{
        id: activity.activityId,
        kind: activity.kind,
        state: activityState(activity.status),
        label: activity.label,
        ...(preview ? { preview, previewKind: activity.previewKind ?? "text" } : {}),
        ...(activity.detail ? { detail: activity.detail } : {}),
      }];
    }
    const activity = toolProgress.get(id);
    if (!activity) return [];
    const detail = toolOutput.get(activity.toolCallId)?.join("\n");
    return [{
      id: activity.toolCallId,
      kind: "tool",
      state: activityState(activity.status),
      label: activity.label,
      ...(detail ? { detail } : {}),
    }];
  });
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
      toolCalls: messageToolCalls(message),
      activities: run && isRunsLastAssistantMessage ? runActivities(run, detail.activities) : [],
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
    if (TERMINAL_RUN_STATUSES.has(run.status) || runIdsWithAssistantMessage.has(run.id)) continue;
    transcript.unshift({
      id: `run-placeholder-${run.id}`,
      role: "assistant",
      text: "",
      toolCalls: [],
      activities: runActivities(run, detail.activities),
      elapsedSeconds: undefined,
      isRunning: true,
      createdAt: Date.parse(run.startedAt ?? run.createdAt),
    });
  }

  return transcript;
}
