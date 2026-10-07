import { projectChatSubagent, canonicalChatToolDetail, canonicalReviewedAgentFailure } from "@matrix-os/contracts";
import type { CanonicalChatRun, CanonicalChatRunActivity } from "@matrix-os/contracts";
import { canonicalChatSafeFailureReason } from "@matrix-os/ui";
import type {
  ConversationActivityGroupPresentation, ConversationActivityPresentation, ConversationMessagePresentation,
  ConversationNoticePresentation, ConversationRequestPresentation, ConversationWorkPresentation,
} from "../../components/conversation/presentation";
const MAX_RUN_ACTIVITY_PROJECTIONS = 500;
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): boolean {
  if (!map.has(key) && map.size >= limit) return false;
  map.set(key, value); return true;
}
export function isActiveRun(run: CanonicalChatRun | undefined): boolean {
  return run !== undefined && [
    "accepted",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
  ].includes(run.status);
}

function selectedModelDisplayName(run: CanonicalChatRun): string {
  const namespaceSeparator = run.selection.model.indexOf(":");
  return namespaceSeparator >= 0
    ? run.selection.model.slice(namespaceSeparator + 1)
    : run.selection.model;
}

export function activeModelStatus(run: CanonicalChatRun | undefined): ConversationWorkPresentation | undefined {
  if (!run || !isActiveRun(run)) return undefined;
  const model = selectedModelDisplayName(run);
  const id = `${run.id}:selected-model`;
  return {
    kind: "activity-group",
    id,
    timestamp: Date.parse(run.startedAt ?? run.createdAt),
    sequence: 0,
    activities: [{
      id,
      kind: "phase",
      state: "running",
      label: "Working",
      preview: `Current model: ${model}`,
      previewKind: "text",
    }],
  };
}

function isDuplicateProviderModelStatus(
  run: CanonicalChatRun,
  activity: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
): boolean {
  const expected = `Current model: ${selectedModelDisplayName(run)}`.toLowerCase();
  return activity.kind === "phase"
    && activity.label === "Working"
    && [activity.summary, activity.preview].some((value) => value?.trim().toLowerCase() === expected);
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

export function replaceThinkingPlaceholders(
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

export function runPresentation(
  run: CanonicalChatRun | undefined,
  activities: CanonicalChatRunActivity[],
  hasFinalAssistantMessage: boolean,
  turnId: string,
  allowRetry: boolean,
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
    if (!uniqueRunActivities.has(activity.id) && uniqueRunActivities.size >= MAX_RUN_ACTIVITY_PROJECTIONS) {
      const oldest = uniqueRunActivities.keys().next();
      if (!oldest.done) uniqueRunActivities.delete(oldest.value);
    }
    uniqueRunActivities.set(activity.id, activity);
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
      if (isDuplicateProviderModelStatus(run, activity)) continue;
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
      output.push(activity.truncated ? `${activity.text}\nOutput was truncated for display.` : activity.text);
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
        actions: activity.allowedDecisions.map((decision) => ({
          kind: "approval" as const,
          requestId: activity.approvalId,
          decision,
          label: decision === "approve_for_session"
            ? "Approve for session"
            : decision === "approve" ? "Approve" : decision === "decline" ? "Decline" : "Cancel",
        })),
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

  const activityGroups: ConversationActivityGroupPresentation[] = [];
  for (const entry of activityOrder) {
    if (entry.type === "agent") {
      const activity = agentActivities.get(entry.id);
      if (!activity) continue;
      const detail = canonicalChatToolDetail(activity.detail ?? activity.summary, toolOutput.get(activity.activityId));
      activityGroups.push({
        kind: "activity-group",
        id: `${run.id}:activities:${activity.subagent ? activity.activityId : activity.id}`,
        timestamp: Date.parse(entry.occurredAt),
        ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
        activities: [{
          id: activity.subagent ? activity.activityId : activity.id,
          kind: activity.kind,
          state: activityState(activity.status),
          label: activity.label,
          ...(activity.subagent ? { subagent: projectChatSubagent(activity.subagent, run.status) } : {}),
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
    const detail = canonicalChatToolDetail(undefined, toolOutput.get(activity.toolCallId));
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
  const active = isActiveRun(run);
  const projectedActivityGroups = active
    ? activityGroups
      .map((item, index) => ({ item, index }))
      .sort((left, right) => (
        (left.item.sequence ?? Number.MAX_SAFE_INTEGER) - (right.item.sequence ?? Number.MAX_SAFE_INTEGER)
        || (left.item.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.item.timestamp ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ))
      .slice(-(MAX_RUN_ACTIVITY_PROJECTIONS - 1))
      .map(({ item }) => item)
    : activityGroups;
  const work: ConversationWorkPresentation[] = [
    ...projectedActivityGroups,
    ...requestOrder.flatMap((key) => {
      const request = requests.get(key);
      return request ? [active ? request : { ...request, state: "resolved" as const, actions: undefined }] : [];
    }),
  ];
  const failed = run.status === "failed" || run.outcome === "failed";
  const stopped = run.status === "aborted" || run.outcome === "aborted";
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
  const reviewedFailure = canonicalReviewedAgentFailure(runError?.error.code, runError?.error.safeMessage);
  const terminalNotice = failed || stopped
    ? {
        kind: "notice" as const,
        id: runError?.id ?? `${run.id}:terminal`,
        phase: "final" as const,
        tone: stopped ? "stopped" as const : "failed" as const,
        label: stopped ? "Agent work stopped" : "Agent work failed",
        ...(!stopped && runError ? { failureCode: runError.error.code } : {}),
        markdown: stopped ? "Run was cancelled."
          : canonicalChatSafeFailureReason(runError?.error.code, runError?.error.safeMessage)
            ?? canonicalChatSafeFailureReason("run_failed")!,
        timestamp: Date.parse(runError?.occurredAt ?? run.completedAt ?? run.updatedAt),
        ...(!stopped && allowRetry && runError?.error.retryable && (reviewedFailure?.retryable ?? true)
          && runError.error.recoveryActions?.includes("retry")
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
