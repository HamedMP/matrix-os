import { canonicalChatToolActivities, canonicalChatInputs, canonicalChatApprovals, canonicalChatTerminalNotices, canonicalAssistantOutputMessages, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";
import { projectCanonicalMessages } from "./canonical-chat-client";

/** Keep terminal outcomes attached to their turn, using only safe fixed copy. */
export function projectCanonicalTranscript(detail: CanonicalChatDetailResponse): ChatMessage[] {
  detail = { ...detail, messages: canonicalAssistantOutputMessages(detail.messages) };
  const messages = projectCanonicalMessages(detail.messages);
  const contextsByTurn = Object.fromEntries(detail.runs.filter((run) => run.context).map((run) => [run.turnId, run.context]));
  const sourceById = Object.fromEntries(detail.messages.map((message) => [message.id, message]));
  for (const message of messages) {
    const source = sourceById[message.id];
    const context = source?.turnId ? contextsByTurn[source.turnId] : undefined;
    if (source?.role === "user" && context) message.metadata = { ...message.metadata, chatRunContext: context };
  }
  for (const run of detail.runs) {
    const anchors = runActivityAnchors(run.id, detail.activities);
    const runMessages = messages.filter((message) => message.role === "assistant" && !message.tool && message.requestId === run.id);
    const tools = canonicalChatToolActivities(run, detail.activities).map((activity) => ({
      anchor: anchors.tools.get(activity.id),
      message: {
        id: `${run.id}:tool:${activity.id}`, role: "system", requestId: run.id,
        tool: activity.label, toolDisplay: activity,
        content: `${activity.state === "running" ? "Using" : "Used"} ${activity.label}`,
        timestamp: Date.parse(run.startedAt ?? run.createdAt),
      } satisfies ChatMessage,
    }));
    if (runMessages.length === 0) {
      const nextMessage = detail.messages.find((message) => message.role === "user" && message.seq > (detail.turns.find((turn) => turn.id === run.turnId)?.baseMessageSeq ?? 0) + 1);
      const index = nextMessage ? messages.findIndex((message) => message.id === nextMessage.id) : -1;
      messages.splice(index < 0 ? messages.length : index, 0, ...tools.map((tool) => tool.message));
      continue;
    }
    // Place each tool before the first text block that started at or after it,
    // so "3 tools, text, 5 tools, text" renders as separate groups between text.
    const textAnchors = runMessages.map((message) => anchors.messages.get(message.id) ?? { time: message.timestamp });
    const before = new Map<string, ChatMessage[]>();
    const after: ChatMessage[] = [];
    for (const tool of tools) {
      const textIndex = tool.anchor
        ? textAnchors.findIndex((anchor) => compareAnchors(anchor, tool.anchor!) >= 0)
        : runMessages.length - 1;
      if (textIndex < 0) after.push(tool.message);
      else before.set(runMessages[textIndex].id, [...(before.get(runMessages[textIndex].id) ?? []), tool.message]);
    }
    for (const [messageId, group] of before) {
      messages.splice(messages.findIndex((message) => message.id === messageId), 0, ...group);
    }
    if (after.length) {
      messages.splice(messages.findIndex((message) => message.id === runMessages.at(-1)!.id) + 1, 0, ...after);
    }
  }
  for (const approval of canonicalChatApprovals(detail)) {
    const existing = messages.find(message => message.id === approval.id);
    if (existing) {
      existing.metadata = { ...existing.metadata, canonicalApproval: approval };
      continue;
    }
    const index = approval.beforeMessageId ? messages.findIndex(message => message.id === approval.beforeMessageId) : -1;
    messages.splice(index < 0 ? messages.length : index, 0, {
      id: approval.id, role: "system", requestId: approval.runId,
      content: approval.title, timestamp: approval.timestamp,
      metadata: { canonicalApproval: approval },
    });
  }
  for (const input of canonicalChatInputs(detail)) {
    const index = input.beforeMessageId ? messages.findIndex(message => message.id === input.beforeMessageId) : -1;
    messages.splice(index < 0 ? messages.length : index, 0, {
      id: input.id, role: "system", requestId: input.runId,
      content: input.title, timestamp: input.timestamp,
      metadata: { canonicalInput: input },
    });
  }
  for (const notice of canonicalChatTerminalNotices(detail)) {
    const nextIndex = notice.beforeMessageId ? messages.findIndex((message) => message.id === notice.beforeMessageId) : -1;
    messages.splice(nextIndex < 0 ? messages.length : nextIndex, 0, {
      id: notice.id, role: "system", requestId: notice.runId,
      content: notice.text, timestamp: notice.timestamp,
      ...(notice.code ? { metadata: { canonicalFailureCode: notice.code } } : {}),
    });
  }
  return messages;
}

type ActivityAnchor = { sequence?: number; time: number };

function compareAnchors(left: ActivityAnchor, right: ActivityAnchor): number {
  if (left.sequence !== undefined && right.sequence !== undefined) return left.sequence - right.sequence;
  return left.time - right.time;
}

/** First position of each tool call and streamed text block within one run. */
function runActivityAnchors(runId: string, activities: CanonicalChatDetailResponse["activities"]) {
  const tools = new Map<string, ActivityAnchor>();
  const messages = new Map<string, ActivityAnchor>();
  const keep = (map: Map<string, ActivityAnchor>, key: string, anchor: ActivityAnchor) => {
    const current = map.get(key);
    if (!current || compareAnchors(anchor, current) < 0) map.set(key, anchor);
  };
  for (const activity of activities) {
    if (activity.runId !== runId) continue;
    const anchor = { ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}), time: Date.parse(activity.occurredAt) };
    if (activity.type === "tool.progress") keep(tools, activity.toolCallId, anchor);
    else if (activity.type === "agent.activity") keep(tools, activity.activityId, anchor);
    else if (activity.type === "assistant.delta") keep(messages, activity.messageId, anchor);
  }
  return { tools, messages };
}
