import { BotRunMessageBody, BotUnassignedMessageBody } from "@matrix-os/ui";
import type { ChatMessage, MessageGroup } from "@/lib/chat";

const messagesFor = (group: MessageGroup): ChatMessage[] => group.type === "message" ? [group.message] : group.messages;
export function botTranscriptPlacement(groups: MessageGroup[]) {
  // Snapshot-local and bounded; keep latest run slots if a legacy message window is oversized.
  const latest = new Map<string, number>();
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    for (const message of messagesFor(groups[index]!)) {
      if (message.requestId && !latest.has(message.requestId) && latest.size < 1_024) latest.set(message.requestId, index);
    }
  }
  const slots: string[][] = groups.map(() => []);
  for (const [runId, index] of latest) slots[index]!.push(runId);
  const requestIds = groups.flatMap(messagesFor).flatMap(message => {
    const request = message.metadata?.canonicalInput;
    return request && typeof request === "object" && "requestId" in request && typeof request.requestId === "string"
      && ("pending" in request && request.pending === true || "submitted" in request && request.submitted === true)
      && !("resolved" in request && request.resolved === true) ? [request.requestId] : [];
  });
  return { slots, runIds: [...latest.keys()], requestIds };
}
type Placement = ReturnType<typeof botTranscriptPlacement>;
/** One inline slot after the last row of each actual canonical run, including tool-only turns. */
export function BotTranscriptRunState({ placement, index }: { placement: Placement; index: number }) {
  const runIds = placement.slots[index] ?? [];
  if (!runIds.length) return null;
  return <div data-agent-message-body={runIds.join(" ")} className="min-w-0">
    <BotRunMessageBody runIds={runIds} requestIds={placement.requestIds}/>
  </div>;
}
export function BotTranscriptFallback({ placement }: { placement: Placement }) {
  return <BotUnassignedMessageBody runIds={placement.runIds} requestIds={placement.requestIds}/>;
}
