import { canonicalChatApprovals, canonicalChatInputs } from "@matrix-os/contracts";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatRunActivity, CanonicalChatTurn } from "@matrix-os/contracts";
import { chatAgentAttribution } from "@matrix-os/ui";
import type { ConversationTurnPresentation, ConversationWorkPresentation } from "../../components/conversation/presentation";
import { historicalChatPresentation } from "./historical-chat-presentation";
import { messagePresentation, messageWork, hasDisplayableMessageContent, promotedAssistantArtifacts, withoutAttachmentReferences } from "./canonical-chat-message-presentation";
import { isActiveRun, runPresentation, activeModelStatus, replaceThinkingPlaceholders } from "./canonical-chat-run-presentation";
const MAX_STREAMED_MESSAGE_PROJECTIONS = 200;
export function canonicalChatPresentation(input: {
  messages: CanonicalChatMessage[];
  turns: CanonicalChatTurn[];
  runs: CanonicalChatRun[];
  activities: CanonicalChatRunActivity[];
  streamedMessageIds?: readonly string[];
}): ConversationTurnPresentation[] {
  const streamedMessageIds = new Set(
    input.streamedMessageIds?.slice(-MAX_STREAMED_MESSAGE_PROJECTIONS) ?? [],
  ); // Per-detail projection, explicitly capped with the message window.
  const approvalViews = canonicalChatApprovals(input);
  const inputViews = canonicalChatInputs(input);
  const latestTurnId = input.turns.reduce<CanonicalChatTurn | undefined>((latest, turn) => (
    latest === undefined
      || turn.baseMessageSeq > latest.baseMessageSeq
      || (turn.baseMessageSeq === latest.baseMessageSeq && turn.createdAt > latest.createdAt)
      ? turn
      : latest
  ), undefined)?.id;
  const views = input.turns.map((turn) => {
    const historical = input.messages.filter(message => message.turnId === turn.id);
    if (!input.runs.some(run => run.turnId === turn.id) && historical.length
      && historical.every(message => message.parts.some(part => part.type === "import_provenance"))) {
      return historicalChatPresentation(historical, turn.id, turn.inputMessageId);
    }
    const userMessage = input.messages.find((message) => message.id === turn.inputMessageId);
    const userFollowups = input.messages.filter((message) => (
      message.turnId === turn.id
      && message.role === "user"
      && message.id !== turn.inputMessageId
    )).sort((left, right) => left.seq - right.seq);
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
    const live = runPresentation(
      run,
      input.activities,
      Boolean(finalMessage),
      turn.id,
      turn.id === latestTurnId,
    );
    const modelStatus = activeModelStatus(run);
    const promotedArtifacts = finalMessage
      ? promotedAssistantArtifacts(assistantMessages, finalMessage)
      : [];
    const finalPresentation = finalMessage
      ? messagePresentation(finalMessage, "final")
      : undefined;
    const unsortedWork = [
      ...(modelStatus ? [modelStatus] : []),
      ...assistantMessages.filter((message) => message.id !== finalMessage?.id).flatMap((message) => {
        const visibleMessage = promotedArtifacts.length > 0
          ? withoutAttachmentReferences(message)
          : message;
        return [
          ...messageWork(message),
          ...(hasDisplayableMessageContent(visibleMessage)
            ? [messagePresentation(visibleMessage, "commentary")]
            : []),
        ];
      }),
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
    const seenApprovals = new Set<string>(); // Per-turn, bounded by snapshot activities/parts.
    const work = replaceThinkingPlaceholders(orderedWork, isActiveRun(run)).flatMap((item): ConversationWorkPresentation[] => {
      if (item.kind !== "request") return [item];
      if (item.requestKind === "input") {
        const input = inputViews.find(view => view.runId === run?.id && view.requestId === item.requestId);
        return [{ ...item, input, state: input?.pending ? "waiting" : "resolved", actions: undefined }];
      }
      if (seenApprovals.has(item.requestId)) return [];
      seenApprovals.add(item.requestId);
      const approval = approvalViews.find(view => view.runId === run?.id && view.approvalId === item.requestId);
      return [{ ...item, label: approval?.title ?? item.label, detail: approval?.description, decision: approval?.decision,
        state: approval?.pending ? "waiting" : "resolved", actions: approval?.pending ? item.actions : undefined }];
    });
    const timeline = [
      ...work.map((item, index) => ({
        kind: "work" as const,
        item,
        timestamp: item.timestamp ?? Number.MAX_SAFE_INTEGER,
        index,
      })),
      ...userFollowups.map((message, index) => ({
        kind: "user-followup" as const,
        message: messagePresentation(message, "commentary"),
        timestamp: Date.parse(message.createdAt),
        index: work.length + index,
      })),
    ].sort((left, right) => (
      left.timestamp - right.timestamp
      || (left.kind === "user-followup" ? -1 : right.kind === "user-followup" ? 1 : left.index - right.index)
    )).map((entry) => entry.kind === "work"
      ? { kind: entry.kind, item: entry.item }
      : { kind: entry.kind, message: entry.message });
    const startedAt = Date.parse(run?.startedAt ?? run?.createdAt ?? turn.createdAt);
    const endedAt = Date.parse(run?.completedAt ?? run?.updatedAt ?? turn.updatedAt);
    return {
      id: turn.id,
      ...(run?.context ? { runContext: run.context } : {}),
      ...(run?.executionRoot ? { executionRoot: run.executionRoot } : {}),
      ...(chatAgentAttribution(run) ? { agentLabel: chatAgentAttribution(run) } : {}),
      startedAt,
      endedAt,
      active: isActiveRun(run),
      ...(userMessage ? { user: messagePresentation(userMessage, "commentary") } : {}),
      ...(userFollowups.length > 0
        ? { userFollowups: userFollowups.map((message) => messagePresentation(message, "commentary")) }
        : {}),
      work,
      ...(timeline.length > 0 ? { timeline } : {}),
      ...(userFollowups.length > 0 ? { expandedByDefault: true } : {}),
      ...(finalMessage && hasDisplayableMessageContent(finalMessage)
        ? {
            final: {
              ...finalPresentation!,
              ...(promotedArtifacts.length > 0
                ? {
                    content: [
                      ...promotedArtifacts,
                      ...(finalPresentation?.content ?? []),
                    ],
                  }
                : {}),
              ...(streamedMessageIds.has(finalMessage.id) ? { wasStreamed: true } : {}),
            },
          }
        : live.streamingFinal
          ? { final: live.streamingFinal }
          : live.failure ? { final: live.failure } : {}),
    };
  });
  const orphans = input.messages.filter(message => !message.turnId && message.parts.some(part => part.type === "import_provenance"));
  if (orphans.length) views.push(historicalChatPresentation(orphans, `history:${orphans[0]!.id}`));
  const seqFor = (view: ConversationTurnPresentation) => {
    const turn = input.turns.find(turn => turn.id === view.id);
    return turn?.baseMessageSeq ?? orphans[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  };
  return views.sort((left, right) => seqFor(left) - seqFor(right));
}
