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
  ConversationMessageContentPresentation,
  ConversationNoticePresentation,
  ConversationRequestPresentation,
  ConversationTurnPresentation,
  ConversationWorkPresentation,
} from "../../components/conversation/presentation";

const MAX_MESSAGE_PART_PROJECTIONS = 64;
const MAX_RUN_ACTIVITY_PROJECTIONS = 500;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): boolean {
  if (!map.has(key) && map.size >= limit) return false;
  map.set(key, value);
  return true;
}

function messageText(message: CanonicalChatMessage): string {
  let output = "";
  let previousWasText = false;
  for (const part of message.parts) {
    if (part.type !== "text" && part.type !== "summary") continue;
    if (output && !(previousWasText && part.type === "text")) output += "\n\n";
    output += part.text;
    previousWasText = part.type === "text";
  }
  return output;
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
      references.push({ id: part.invocation.descriptorId, kind: "invocation", label: part.invocation.invocation });
    }
  }
  const content = messageContent(message, markdown);
  return {
    kind: "message",
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    phase,
    markdown,
    copyText: markdown,
    timestamp: Date.parse(message.createdAt),
    ...(content.length > 0 ? { content } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageContent(
  message: CanonicalChatMessage,
  markdown: string,
): ConversationMessageContentPresentation[] {
  const matches: Array<{
    start: number;
    end: number;
    segment: ConversationMessageContentPresentation;
  }> = [];
  const unmatched: ConversationMessageContentPresentation[] = [];
  const images: ConversationMessageContentPresentation[] = [];
  for (const part of message.parts) {
    if (part.type === "invocation_reference") {
      const token = part.invocation.invocation;
      const start = markdown.indexOf(token);
      const segment = {
        kind: "reference" as const,
        id: part.invocation.descriptorId,
        referenceKind: "invocation" as const,
        label: token,
      };
      if (start >= 0) matches.push({ start, end: start + token.length, segment });
      else unmatched.push(segment);
    } else if (part.type === "resource_reference") {
      const pattern = new RegExp(`\\[${escapeRegExp(part.resource.label)}\\]\\([^)]*\\)`);
      const found = pattern.exec(markdown);
      const segment = {
        kind: "reference" as const,
        id: part.resource.id,
        referenceKind: "resource" as const,
        label: part.resource.label,
      };
      if (found?.index !== undefined) {
        matches.push({ start: found.index, end: found.index + found[0].length, segment });
      } else unmatched.push(segment);
    } else if (part.type === "attachment_reference") {
      if (part.kind === "image" && part.ownerReference) {
        images.push({
          kind: "image",
          id: part.attachmentId,
          label: part.label,
          src: `/api/files/blob?path=${encodeURIComponent(part.ownerReference)}`,
        });
      } else {
        unmatched.push({
          kind: "reference",
          id: part.attachmentId,
          referenceKind: "file",
          label: part.label,
        });
      }
    }
  }
  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const content: ConversationMessageContentPresentation[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) content.push({ kind: "text", text: markdown.slice(cursor, match.start) });
    content.push(match.segment);
    cursor = match.end;
  }
  if (cursor < markdown.length) content.push({ kind: "text", text: markdown.slice(cursor) });
  return [...content, ...unmatched, ...images];
}

function messageWork(message: CanonicalChatMessage): ConversationWorkPresentation[] {
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
      const isNew = !toolRequests.has(part.toolCallId);
      if (setBounded(toolRequests, part.toolCallId, part, MAX_MESSAGE_PART_PROJECTIONS) && isNew) {
        toolOrder.push(part.toolCallId);
      }
    } else if (part.type === "tool_result") {
      const isNew = !toolRequests.has(part.toolCallId) && !toolResults.has(part.toolCallId);
      if (setBounded(toolResults, part.toolCallId, part, MAX_MESSAGE_PART_PROJECTIONS) && isNew) {
        toolOrder.push(part.toolCallId);
      }
    } else if (part.type === "approval_request") {
      const isNew = !approvals.has(part.approvalId);
      if (setBounded(approvals, part.approvalId, part, MAX_MESSAGE_PART_PROJECTIONS) && isNew) {
        approvalOrder.push(part.approvalId);
      }
    } else if (part.type === "approval_result") {
      setBounded(approvalResults, part.approvalId, part, MAX_MESSAGE_PART_PROJECTIONS);
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

function isGenericThinkingPlaceholder(item: ConversationWorkPresentation): boolean {
  if (item.kind !== "activity-group" || item.activities.length !== 1) return false;
  const [activity] = item.activities;
  return activity?.kind === "reasoning"
    && activity.label === "Thinking"
    && activity.preview === undefined
    && activity.detail === undefined;
}

function replaceThinkingPlaceholders(
  work: ConversationWorkPresentation[],
  active: boolean,
): ConversationWorkPresentation[] {
  if (!active) return work.filter((item) => !isGenericThinkingPlaceholder(item));
  const visible: ConversationWorkPresentation[] = [];
  let pendingThinkingIndex: number | undefined;
  let hasVisibleWork = false;
  for (const item of work) {
    if (isGenericThinkingPlaceholder(item)) {
      if (hasVisibleWork) continue;
      visible.push(item);
      pendingThinkingIndex = visible.length - 1;
      continue;
    }
    hasVisibleWork = true;
    if (pendingThinkingIndex !== undefined) {
      visible.splice(pendingThinkingIndex, 1);
      pendingThinkingIndex = undefined;
    }
    visible.push(item);
  }
  return visible;
}

function runPresentation(
  run: CanonicalChatRun | undefined,
  activities: CanonicalChatRunActivity[],
  hasFinalAssistantMessage: boolean,
  turnId: string,
): {
  work: ConversationWorkPresentation[];
  streamingFinal?: ConversationMessagePresentation;
  failure?: ConversationNoticePresentation;
} {
  if (!run) return { work: [] };
  const ordered = activities
    .map((activity, index) => ({ activity, index }))
    .filter(({ activity }) => activity.runId === run.id)
    .sort((left, right) => {
      const leftSequence = left.activity.sequence;
      const rightSequence = right.activity.sequence;
      if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return left.index - right.index;
    });
  const uniqueRunActivities = new Map<string, CanonicalChatRunActivity>();
  for (const { activity } of ordered) {
    setBounded(uniqueRunActivities, activity.id, activity, MAX_RUN_ACTIVITY_PROJECTIONS);
  }
  const runActivities = [...uniqueRunActivities.values()];
  const toolProgress = new Map<string, Extract<CanonicalChatRunActivity, { type: "tool.progress" }>>();
  const agentActivities = new Map<string, Extract<CanonicalChatRunActivity, { type: "agent.activity" }>>();
  const activityOrder: Array<{
    type: "tool" | "agent";
    id: string;
    occurredAt: string;
    sequence?: number;
  }> = [];
  const toolOutput = new Map<string, string[]>();
  const streamed = new Map<string, { text: string; occurredAt: string }>();
  let runError: Extract<CanonicalChatRunActivity, { type: "run.error" }> | undefined;
  const requests = new Map<string, ConversationRequestPresentation>();
  const requestOrder: string[] = [];

  for (const activity of runActivities) {
    if (activity.type === "tool.progress") {
      if (!toolProgress.has(activity.toolCallId)) {
        activityOrder.push({
          type: "tool",
          id: activity.toolCallId,
          occurredAt: activity.occurredAt,
          ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
        });
      }
      setBounded(toolProgress, activity.toolCallId, activity, MAX_RUN_ACTIVITY_PROJECTIONS);
    } else if (activity.type === "agent.activity") {
      if (!agentActivities.has(activity.activityId)) {
        activityOrder.push({
          type: "agent",
          id: activity.activityId,
          occurredAt: activity.occurredAt,
          ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
        });
      }
      setBounded(agentActivities, activity.activityId, activity, MAX_RUN_ACTIVITY_PROJECTIONS);
    } else if (activity.type === "tool.output") {
      const output = toolOutput.get(activity.toolCallId) ?? [];
      output.push(activity.text);
      setBounded(toolOutput, activity.toolCallId, output, MAX_RUN_ACTIVITY_PROJECTIONS);
    } else if (activity.type === "assistant.delta") {
      const current = streamed.get(activity.messageId);
      setBounded(streamed, activity.messageId, {
        text: `${current?.text ?? ""}${activity.delta}`,
        occurredAt: activity.occurredAt,
      }, MAX_RUN_ACTIVITY_PROJECTIONS);
    } else if (activity.type === "run.error") {
      runError = activity;
    } else if (activity.type === "approval.requested") {
      const key = `approval:${activity.approvalId}`;
      const isNew = !requests.has(key);
      if (setBounded(requests, key, {
        kind: "request",
        id: activity.id,
        phase: "commentary",
        requestKind: "approval",
        requestId: activity.approvalId,
        state: "waiting",
        label: activity.title,
        risk: activity.risk,
        timestamp: Date.parse(activity.occurredAt),
      }, MAX_RUN_ACTIVITY_PROJECTIONS) && isNew) requestOrder.push(key);
    } else if (activity.type === "approval.resolved") {
      const key = `approval:${activity.approvalId}`;
      const request = requests.get(key);
      if (request) setBounded(requests, key, { ...request, state: "resolved", actions: undefined }, MAX_RUN_ACTIVITY_PROJECTIONS);
    } else if (activity.type === "input.requested") {
      const key = `input:${activity.requestId}`;
      const isNew = !requests.has(key);
      if (setBounded(requests, key, {
        kind: "request",
        id: activity.id,
        phase: "commentary",
        requestKind: "input",
        requestId: activity.requestId,
        state: "waiting",
        label: activity.title,
        timestamp: Date.parse(activity.occurredAt),
        actions: [{ kind: "input", requestId: activity.requestId, label: "Submit" }],
      }, MAX_RUN_ACTIVITY_PROJECTIONS) && isNew) requestOrder.push(key);
    } else if (activity.type === "input.resolved") {
      const key = `input:${activity.requestId}`;
      const request = requests.get(key);
      if (request) setBounded(requests, key, { ...request, state: "resolved", actions: undefined }, MAX_RUN_ACTIVITY_PROJECTIONS);
    }
  }

  const activityGroups: ConversationWorkPresentation[] = [];
  for (const entry of activityOrder) {
    if (entry.type === "agent") {
      const activity = agentActivities.get(entry.id);
      if (!activity) continue;
      const detail = activity.detail ?? activity.summary ?? toolOutput.get(activity.activityId)?.join("\n");
      activityGroups.push({
        kind: "activity-group",
        id: `${run.id}:activities:${activity.id}`,
        timestamp: Date.parse(entry.occurredAt),
        ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
        activities: [{
          id: activity.id,
          kind: activity.kind,
          state: activityState(activity.status),
          label: activity.label,
          ...(activity.preview ? {
            preview: activity.preview,
            previewKind: activity.previewKind,
            copyText: activity.previewKind === "command" ? activity.preview : undefined,
          } : activity.summary ? { preview: activity.summary, previewKind: "text" as const } : {}),
          ...(detail ? { detail } : {}),
        }],
      });
      continue;
    }
    const activity = toolProgress.get(entry.id);
    if (!activity) continue;
    const detail = toolOutput.get(activity.toolCallId)?.join("\n");
    activityGroups.push({
      kind: "activity-group",
      id: `${run.id}:activities:${activity.id}`,
      timestamp: Date.parse(entry.occurredAt),
      ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
      activities: [{
        id: activity.id,
        kind: "tool",
        state: activityState(activity.status),
        label: activity.label,
        ...(detail ? { detail, preview: detail, previewKind: "text" as const } : {}),
      }],
    });
  }
  const work: ConversationWorkPresentation[] = [
    ...activityGroups,
    ...requestOrder.flatMap((key) => {
      const request = requests.get(key);
      return request ? [request] : [];
    }),
  ];
  const failed = run.status === "failed" || run.outcome === "failed";
  const stopped = run.status === "aborted" || run.outcome === "aborted";
  const active = isActiveRun(run);
  const streamedMessages = [...streamed.entries()].map(([messageId, value]) => ({
    kind: "message" as const,
    id: messageId,
    role: "assistant" as const,
    phase: "commentary" as const,
    markdown: value.text,
    copyText: value.text,
    timestamp: Date.parse(value.occurredAt),
  }));
  const streamingFinalMessage = !active && !hasFinalAssistantMessage && !failed && !stopped
    ? streamedMessages.at(-1)
    : undefined;
  work.push(...streamedMessages.filter((message) => message.id !== streamingFinalMessage?.id));
  const streamingFinal = streamingFinalMessage
    ? {
        ...streamingFinalMessage,
        phase: "final" as const,
      }
    : undefined;
  const terminalNotice = failed || stopped
    ? {
        kind: "notice" as const,
        id: runError?.id ?? `${run.id}:terminal`,
        phase: "final" as const,
        tone: stopped ? "stopped" as const : "failed" as const,
        label: stopped ? "Agent work stopped" : "Agent work failed",
        markdown: stopped ? "Run was cancelled." : runError?.error.safeMessage ?? "The agent run failed.",
        timestamp: Date.parse(runError?.occurredAt ?? run.completedAt ?? run.updatedAt),
        ...(!stopped && runError?.error.retryable && runError.error.recoveryActions?.includes("retry")
          ? { actions: [{ kind: "retry" as const, turnId, label: "Retry" }] }
          : {}),
      }
    : undefined;
  return {
    work,
    ...(streamingFinal ? { streamingFinal } : {}),
    ...(terminalNotice ? { failure: terminalNotice } : {}),
  };
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
      message.turnId === turn.id
      && message.role === "assistant"
      && (run === undefined || message.runId === run.id)
    )).sort((left, right) => left.seq - right.seq);
    const terminalFailure = run?.status === "failed" || run?.status === "aborted"
      || run?.outcome === "failed" || run?.outcome === "aborted";
    const finalMessage = terminalFailure || isActiveRun(run) ? undefined : assistantMessages.at(-1);
    const live = runPresentation(run, input.activities, Boolean(finalMessage), turn.id);
    const unsortedWork = [
      ...assistantMessages.filter((message) => message.id !== finalMessage?.id).flatMap((message) => [
        ...messageWork(message),
        ...(messageText(message) ? [messagePresentation(message, "commentary")] : []),
      ]),
      ...(finalMessage ? messageWork(finalMessage) : []),
      ...live.work,
    ];
    const activityWork = unsortedWork.filter((item) => item.kind === "activity-group")
      .map((item, index) => ({ item, index }))
      .sort((left, right) => (
        (left.item.sequence ?? Number.MAX_SAFE_INTEGER) - (right.item.sequence ?? Number.MAX_SAFE_INTEGER)
        || (left.item.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.item.timestamp ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ));
    const otherWork = unsortedWork.filter((item) => item.kind !== "activity-group")
      .map((item, index) => ({ item, index }))
      .sort((left, right) => left.item.timestamp - right.item.timestamp || left.index - right.index);
    const orderedWork: ConversationWorkPresentation[] = [];
    let activityIndex = 0;
    let otherIndex = 0;
    while (activityIndex < activityWork.length || otherIndex < otherWork.length) {
      const activity = activityWork[activityIndex];
      const other = otherWork[otherIndex];
      if (!other || (activity && (activity.item.timestamp ?? Number.MAX_SAFE_INTEGER) <= other.item.timestamp)) {
        orderedWork.push(activity!.item);
        activityIndex += 1;
      } else {
        orderedWork.push(other.item);
        otherIndex += 1;
      }
    }
    const work = replaceThinkingPlaceholders(orderedWork, isActiveRun(run));
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
