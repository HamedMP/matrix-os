import type {
  CanonicalChatMessage,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
} from "@matrix-os/contracts";
import type {
  ConversationActivityPresentation,
  ConversationMessagePresentation,
  ConversationNoticePresentation,
  ConversationTurnPresentation,
  ConversationWorkPresentation,
} from "../../components/conversation/presentation";

function messageText(message: CanonicalChatMessage): string {
  return message.parts.flatMap((part) => {
    if (part.type === "text" || part.type === "summary") return [part.text];
    if (part.type === "status") return [part.detail ? `${part.label}\n\n${part.detail}` : part.label];
    if (part.type === "tool_result" && part.text) return [part.text];
    return [];
  }).join("\n\n");
}

function messagePresentation(
  message: CanonicalChatMessage,
  phase: "commentary" | "final",
): ConversationMessagePresentation {
  const markdown = messageText(message);
  const attachments = message.parts.flatMap((part) => part.type === "attachment_reference"
    ? [{ id: part.attachmentId, kind: "file" as const, label: part.label }]
    : []);
  return {
    kind: "message",
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    phase,
    markdown,
    copyText: markdown,
    timestamp: Date.parse(message.createdAt),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function isActiveRun(run: CanonicalChatRun | undefined): boolean {
  return run !== undefined && [
    "accepted",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
  ].includes(run.status);
}

function activityState(
  status:
    | Extract<CanonicalChatRunActivity, { type: "tool.progress" }>["status"]
    | Extract<CanonicalChatRunActivity, { type: "agent.activity" }>["status"],
): ConversationActivityPresentation["state"] {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  if (status === "partial") return "partial";
  if (status === "completed") return "completed";
  return "running";
}

function runPresentation(
  run: CanonicalChatRun | undefined,
  activities: CanonicalChatRunActivity[],
  hasCommittedAssistantMessage: boolean,
): {
  work: ConversationWorkPresentation[];
  streamingFinal?: ConversationMessagePresentation;
  failure?: ConversationNoticePresentation;
} {
  if (!run) return { work: [] };
  const runActivities = activities.filter((activity) => activity.runId === run.id);
  const toolProgress = new Map<string, Extract<CanonicalChatRunActivity, { type: "tool.progress" }>>();
  const agentActivities = new Map<string, Extract<CanonicalChatRunActivity, { type: "agent.activity" }>>();
  const activityOrder: Array<{ type: "tool" | "agent"; id: string }> = [];
  const toolOutput = new Map<string, string[]>();
  const streamed = new Map<string, { text: string; occurredAt: string }>();
  let runError: Extract<CanonicalChatRunActivity, { type: "run.error" }> | undefined;

  for (const activity of runActivities) {
    if (activity.type === "tool.progress") {
      if (!toolProgress.has(activity.toolCallId)) {
        activityOrder.push({ type: "tool", id: activity.toolCallId });
      }
      toolProgress.set(activity.toolCallId, activity);
    } else if (activity.type === "agent.activity") {
      const current = agentActivities.get(activity.activityId);
      if (!current) activityOrder.push({ type: "agent", id: activity.activityId });
      agentActivities.set(activity.activityId, {
        ...activity,
        id: current?.id ?? activity.id,
      });
    } else if (activity.type === "tool.output") {
      const output = toolOutput.get(activity.toolCallId) ?? [];
      output.push(activity.text);
      toolOutput.set(activity.toolCallId, output);
    } else if (activity.type === "assistant.delta") {
      const current = streamed.get(activity.messageId);
      streamed.set(activity.messageId, {
        text: `${current?.text ?? ""}${activity.delta}`,
        occurredAt: activity.occurredAt,
      });
    } else if (activity.type === "run.error") {
      runError = activity;
    }
  }

  const activityRows: ConversationActivityPresentation[] = [];
  for (const entry of activityOrder) {
    if (entry.type === "agent") {
      const activity = agentActivities.get(entry.id);
      if (!activity) continue;
      const detail = activity.summary ?? toolOutput.get(activity.activityId)?.join("\n");
      activityRows.push({
        id: activity.id,
        kind: activity.kind,
        state: activityState(activity.status),
        label: activity.label,
        ...(detail
          ? { detail, preview: detail, previewKind: "text" as const }
          : {}),
      });
      continue;
    }
    const activity = toolProgress.get(entry.id);
    if (!activity) continue;
    const detail = toolOutput.get(activity.toolCallId)?.join("\n");
    activityRows.push({
      id: activity.id,
      kind: "tool",
      state: activityState(activity.status),
      label: activity.label,
      ...(detail ? { detail, preview: detail, previewKind: "text" as const } : {}),
    });
  }
  const work: ConversationWorkPresentation[] = activityRows.length > 0
    ? [{ kind: "activity-group", id: `${run.id}:activities`, activities: activityRows }]
    : [];
  const streamedMessage = [...streamed.entries()].at(-1);
  const streamingFinal = !hasCommittedAssistantMessage && streamedMessage
    ? {
        kind: "message" as const,
        id: streamedMessage[0],
        role: "assistant" as const,
        phase: "final" as const,
        markdown: streamedMessage[1].text,
        copyText: streamedMessage[1].text,
        timestamp: Date.parse(streamedMessage[1].occurredAt),
      }
    : undefined;
  const failure = !hasCommittedAssistantMessage && !streamingFinal && runError
    ? {
        kind: "notice" as const,
        id: runError.id,
        phase: "final" as const,
        tone: "failed" as const,
        label: "Agent work failed",
        markdown: runError.error.safeMessage,
        timestamp: Date.parse(runError.occurredAt),
      }
    : undefined;
  return { work, ...(streamingFinal ? { streamingFinal } : {}), ...(failure ? { failure } : {}) };
}

export function canonicalChatPresentation(input: {
  messages: CanonicalChatMessage[];
  turns: CanonicalChatTurn[];
  runs: CanonicalChatRun[];
  activities: CanonicalChatRunActivity[];
}): ConversationTurnPresentation[] {
  return input.turns.map((turn) => {
    const userMessage = input.messages.find((message) => message.id === turn.inputMessageId);
    const runs = input.runs.filter((run) => run.turnId === turn.id)
      .sort((left, right) => left.attempt - right.attempt);
    const run = runs.at(-1);
    const assistantMessages = input.messages.filter((message) => (
      message.turnId === turn.id && message.role === "assistant"
    ));
    const finalMessage = assistantMessages.at(-1);
    const live = runPresentation(run, input.activities, Boolean(finalMessage));
    const work = [
      ...assistantMessages.slice(0, -1).map((message) => messagePresentation(message, "commentary")),
      ...live.work,
    ];
    const startedAt = Date.parse(run?.startedAt ?? run?.createdAt ?? turn.createdAt);
    const endedAt = Date.parse(run?.completedAt ?? run?.updatedAt ?? turn.updatedAt);
    return {
      id: turn.id,
      startedAt,
      endedAt,
      active: isActiveRun(run),
      ...(userMessage ? { user: messagePresentation(userMessage, "commentary") } : {}),
      work,
      ...(finalMessage
        ? { final: messagePresentation(finalMessage, "final") }
        : live.streamingFinal
          ? { final: live.streamingFinal }
          : live.failure ? { final: live.failure } : {}),
    };
  });
}
