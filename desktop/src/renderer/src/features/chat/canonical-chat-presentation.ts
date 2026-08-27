import type {
  CanonicalChatMessage,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
} from "@matrix-os/contracts";
import type {
  ConversationAttachmentPresentation,
  ConversationActivityPresentation,
  ConversationMessagePresentation,
  ConversationNoticePresentation,
  ConversationRequestPresentation,
  ConversationTurnPresentation,
  ConversationWorkPresentation,
} from "../../components/conversation/presentation";

function messageText(message: CanonicalChatMessage): string {
  return message.parts.flatMap((part) => {
    if (part.type === "text" || part.type === "summary") return [part.text];
    return [];
  }).join("\n\n");
}

function messagePresentation(
  message: CanonicalChatMessage,
  phase: "commentary" | "final",
): ConversationMessagePresentation {
  const markdown = messageText(message);
  const references: ConversationAttachmentPresentation[] = [];
  for (const part of message.parts) {
    if (part.type === "attachment_reference") {
      references.push({ id: part.attachmentId, kind: "file", label: part.label });
    } else if (part.type === "resource_reference") {
      references.push({ id: part.resource.id, kind: "resource", label: part.resource.label });
    } else if (part.type === "invocation_reference") {
      references.push({
        id: part.invocation.descriptorId,
        kind: "invocation",
        label: part.invocation.invocation,
      });
    }
  }
  return {
    kind: "message",
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    phase,
    markdown,
    copyText: markdown,
    timestamp: Date.parse(message.createdAt),
    ...(references.length > 0 ? { references } : {}),
  };
}

function messageWork(
  message: CanonicalChatMessage,
): ConversationWorkPresentation[] {
  const toolRequests = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "tool_request" }>>();
  const toolResults = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "tool_result" }>>();
  const toolOrder: string[] = [];
  const approvals = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "approval_request" }>>();
  const approvalResults = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "approval_result" }>>();
  const approvalOrder: string[] = [];
  const notices: ConversationNoticePresentation[] = [];
  const timestamp = Date.parse(message.createdAt);

  for (const part of message.parts) {
    if (part.type === "tool_request") {
      if (!toolRequests.has(part.toolCallId)) toolOrder.push(part.toolCallId);
      toolRequests.set(part.toolCallId, part);
    } else if (part.type === "tool_result") {
      if (!toolRequests.has(part.toolCallId) && !toolResults.has(part.toolCallId)) toolOrder.push(part.toolCallId);
      toolResults.set(part.toolCallId, part);
    } else if (part.type === "approval_request") {
      if (!approvals.has(part.approvalId)) approvalOrder.push(part.approvalId);
      approvals.set(part.approvalId, part);
    } else if (part.type === "approval_result") {
      approvalResults.set(part.approvalId, part);
    } else if (part.type === "status") {
      notices.push({
        kind: "notice",
        id: `${message.id}:status:${notices.length}`,
        phase: "commentary",
        tone: part.tone === "error" ? "failed" : part.tone,
        label: part.label,
        markdown: part.detail ?? "",
        timestamp,
      });
    }
  }

  const tools: ConversationWorkPresentation[] = toolOrder.length > 0
    ? [{
        kind: "activity-group",
        id: `${message.id}:tools`,
        activities: toolOrder.map((toolCallId) => {
          const request = toolRequests.get(toolCallId);
          const result = toolResults.get(toolCallId);
          const state = result?.outcome === "failed"
            ? "failed" as const
            : result?.outcome === "cancelled"
              ? "stopped" as const
              : result ? "completed" as const : "running" as const;
          const detail = [request?.inputPreview, result?.text].filter(Boolean).join("\n\n");
          return {
            id: `${message.id}:${toolCallId}`,
            kind: "tool" as const,
            state,
            label: request?.label ?? "Tool result",
            ...(detail ? { detail, preview: request?.inputPreview ?? result?.text, previewKind: "text" as const } : {}),
          };
        }),
      }]
    : [];
  const requests: ConversationRequestPresentation[] = approvalOrder.map((approvalId) => {
    const request = approvals.get(approvalId)!;
    const resolved = approvalResults.get(approvalId);
    return {
      kind: "request",
      id: `${message.id}:approval:${approvalId}`,
      phase: "commentary",
      requestKind: "approval",
      requestId: approvalId,
      state: resolved ? "resolved" : "waiting",
      label: request.title,
      detail: request.description,
      risk: request.risk,
      timestamp,
      ...(resolved ? {} : {
        actions: request.allowedDecisions.map((decision) => ({
          kind: "approval" as const,
          requestId: approvalId,
          decision,
          label: decision === "approve_for_session"
            ? "Approve for session"
            : decision === "approve" ? "Approve" : decision === "decline" ? "Decline" : "Cancel",
        })),
      }),
    };
  });
  return [...tools, ...requests, ...notices];
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
  turnId: string,
): {
  work: ConversationWorkPresentation[];
  streamingFinal?: ConversationMessagePresentation;
  failure?: ConversationNoticePresentation;
} {
  if (!run) return { work: [] };
  const uniqueRunActivities = new Map<string, CanonicalChatRunActivity>();
  for (const activity of activities) {
    if (activity.runId === run.id) uniqueRunActivities.set(activity.id, activity);
  }
  const runActivities = [...uniqueRunActivities.values()];
  const toolProgress = new Map<string, Extract<CanonicalChatRunActivity, { type: "tool.progress" }>>();
  const agentActivities = new Map<string, Extract<CanonicalChatRunActivity, { type: "agent.activity" }>>();
  const activityOrder: Array<{ type: "tool" | "agent"; id: string }> = [];
  const toolOutput = new Map<string, string[]>();
  const streamed = new Map<string, { text: string; occurredAt: string }>();
  let runError: Extract<CanonicalChatRunActivity, { type: "run.error" }> | undefined;
  const requests = new Map<string, ConversationRequestPresentation>();
  const requestOrder: string[] = [];

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
    } else if (activity.type === "approval.requested") {
      const key = `approval:${activity.approvalId}`;
      if (!requests.has(key)) requestOrder.push(key);
      requests.set(key, {
        kind: "request",
        id: activity.id,
        phase: "commentary",
        requestKind: "approval",
        requestId: activity.approvalId,
        state: "waiting",
        label: activity.title,
        risk: activity.risk,
        timestamp: Date.parse(activity.occurredAt),
      });
    } else if (activity.type === "approval.resolved") {
      const key = `approval:${activity.approvalId}`;
      const current = requests.get(key);
      if (current) requests.set(key, { ...current, state: "resolved" });
    } else if (activity.type === "input.requested") {
      const key = `input:${activity.requestId}`;
      if (!requests.has(key)) requestOrder.push(key);
      requests.set(key, {
        kind: "request",
        id: activity.id,
        phase: "commentary",
        requestKind: "input",
        requestId: activity.requestId,
        state: "waiting",
        label: activity.title,
        timestamp: Date.parse(activity.occurredAt),
        actions: [{ kind: "input", requestId: activity.requestId, label: "Submit" }],
      });
    } else if (activity.type === "input.resolved") {
      const key = `input:${activity.requestId}`;
      const current = requests.get(key);
      if (current) requests.set(key, { ...current, state: "resolved", actions: undefined });
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
  const work: ConversationWorkPresentation[] = [
    ...(activityRows.length > 0
      ? [{ kind: "activity-group" as const, id: `${run.id}:activities`, activities: activityRows }]
      : []),
    ...requestOrder.flatMap((key) => {
      const request = requests.get(key);
      return request ? [request] : [];
    }),
  ];
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
        ...(runError.error.retryable && runError.error.recoveryActions?.includes("retry")
          ? { actions: [{ kind: "retry" as const, turnId, label: "Retry" }] }
          : {}),
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
    const live = runPresentation(run, input.activities, Boolean(finalMessage), turn.id);
    const work = [
      ...assistantMessages.slice(0, -1).flatMap((message) => [
        ...messageWork(message),
        ...(messageText(message) ? [messagePresentation(message, "commentary")] : []),
      ]),
      ...(finalMessage ? messageWork(finalMessage) : []),
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
      ...(finalMessage && messageText(finalMessage)
        ? { final: messagePresentation(finalMessage, "final") }
        : live.streamingFinal
          ? { final: live.streamingFinal }
          : live.failure ? { final: live.failure } : {}),
    };
  });
}
