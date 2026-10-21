import type { ConversationTurnPresentation } from "./presentation";

/** Use the same rendered rows for the turn body and legacy Bot request deduplication. */
export function conversationTurnVisibility(turn: ConversationTurnPresentation, expanded: boolean) {
  const showWork = turn.active || expanded;
  const terminalPartial = !turn.active
    && turn.final?.kind === "notice"
    && (turn.final.tone === "failed" || turn.final.tone === "stopped")
    ? [...turn.work].reverse().find((item) => item.kind === "message")
    : undefined;
  const visibleWork = showWork ? turn.work : terminalPartial ? [terminalPartial] : [];
  const visibleTimeline = turn.timeline?.filter((entry) => (
    entry.kind === "user-followup" || showWork || (terminalPartial !== undefined && entry.item.id === terminalPartial.id)
  ));
  const renderedWork = visibleTimeline?.flatMap(entry => entry.kind === "work" ? [entry.item] : []) ?? visibleWork;
  const pendingRequestIds = [...renderedWork, ...(turn.final ? [turn.final] : [])].flatMap(item => (
    item.kind === "request" && item.input && !item.input.resolved && (item.input.pending || item.input.submitted)
      ? [item.requestId] : []
  ));
  return { showWork, visibleWork, visibleTimeline, pendingRequestIds };
}
