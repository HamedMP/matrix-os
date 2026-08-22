import type { AgentThreadEvent } from "@matrix-os/contracts";

export type AssistantEvent = Extract<AgentThreadEvent, { type: "assistant.text.delta" | "assistant.text.completed" }>;
export type ToolEvent = Extract<AgentThreadEvent, { type: "tool.started" | "tool.output" | "tool.completed" }>;

// `order` is the index of the item's first event; `endOrder` the index of its
// last. The projection never changes the order received from the Gateway.
export type ConversationTimelineItem =
  | { kind: "assistant"; key: string; events: AssistantEvent[]; order: number; endOrder: number }
  | { kind: "tool"; key: string; events: ToolEvent[]; order: number; endOrder: number }
  | { kind: "event"; event: AgentThreadEvent; order: number; endOrder: number };

export type TimelineItem =
  | Exclude<ConversationTimelineItem, { kind: "tool" }>
  | { kind: "tool-run"; key: string; runs: Array<Extract<ConversationTimelineItem, { kind: "tool" }>>; order: number; endOrder: number };

export type TimelineSection =
  | { kind: "standalone"; key: string; item: TimelineItem }
  | { kind: "turn"; key: string; items: TimelineItem[]; settled: boolean };

function conversationItems(events: AgentThreadEvent[]): ConversationTimelineItem[] {
  const assistants = new Map<string, Extract<ConversationTimelineItem, { kind: "assistant" }>>();
  const tools = new Map<string, Extract<ConversationTimelineItem, { kind: "tool" }>>();
  const items: ConversationTimelineItem[] = [];
  for (const [order, event] of events.entries()) {
    if (event.type === "assistant.text.delta" || event.type === "assistant.text.completed") {
      const group = assistants.get(event.messageId);
      if (group) {
        group.events.push(event);
        group.endOrder = order;
      } else {
        const item: Extract<ConversationTimelineItem, { kind: "assistant" }> = {
          kind: "assistant",
          key: `assistant:${event.messageId}`,
          events: [event],
          order,
          endOrder: order,
        };
        assistants.set(event.messageId, item);
        items.push(item);
      }
      continue;
    }
    if (event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.completed") {
      const group = tools.get(event.toolCallId);
      if (group) {
        group.events.push(event);
        group.endOrder = order;
      } else {
        const item: Extract<ConversationTimelineItem, { kind: "tool" }> = {
          kind: "tool",
          key: `tool:${event.toolCallId}`,
          events: [event],
          order,
          endOrder: order,
        };
        tools.set(event.toolCallId, item);
        items.push(item);
      }
      continue;
    }
    items.push({ kind: "event", event, order, endOrder: order });
  }
  return items;
}

function groupConsecutiveTools(items: ConversationTimelineItem[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      timeline.push(item);
      continue;
    }
    const previous = timeline.at(-1);
    if (previous?.kind === "tool-run") {
      previous.runs.push(item);
      previous.endOrder = item.endOrder;
      continue;
    }
    timeline.push({ kind: "tool-run", key: `run:${item.key}`, runs: [item], order: item.order, endOrder: item.endOrder });
  }
  return timeline;
}

/**
 * Projects append-only events into turn sections without compensating for
 * stream ordering. Older turns are settled; the last turn follows the
 * authoritative thread lifecycle supplied by the caller.
 */
export function projectConversationTimeline(events: AgentThreadEvent[], threadActive: boolean): {
  items: TimelineItem[];
  sections: TimelineSection[];
} {
  const items = groupConsecutiveTools(conversationItems(events));
  const sections: TimelineSection[] = [];
  let turn: Extract<TimelineSection, { kind: "turn" }> | null = null;

  for (const item of items) {
    if (item.kind === "event" && item.event.type === "user.message") {
      if (turn) sections.push(turn);
      turn = { kind: "turn", key: `turn:${item.event.messageId}`, items: [item], settled: false };
      continue;
    }
    if (turn) {
      turn.items.push(item);
      continue;
    }
    const key = item.kind === "event" ? `event:${item.event.eventId}` : item.key;
    sections.push({ kind: "standalone", key: `standalone:${key}`, item });
  }
  if (turn) sections.push(turn);

  const turns = sections.filter((section): section is Extract<TimelineSection, { kind: "turn" }> => section.kind === "turn");
  for (const [index, section] of turns.entries()) {
    section.settled = index < turns.length - 1 || !threadActive;
  }
  return { items, sections };
}
