import { ThreadIdSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import type { ChannelReply } from "../channels/types.js";
import type { CodingAgentThreadStore } from "./thread-store.js";

const PUSH_CHAT_ID = "coding-agents";

type AttentionNotificationKind = "approval" | "input" | "failed";

export interface CodingAgentAttentionNotificationSender {
  send(reply: ChannelReply): Promise<void>;
}

export interface CodingAgentAttentionNotificationsOptions {
  threads: CodingAgentThreadStore;
  send: (reply: ChannelReply) => Promise<void>;
}

function notificationKindFor(events: AgentThreadEvent[]): AttentionNotificationKind | null {
  for (const event of events) {
    if (event.type === "approval.requested") return "approval";
    if (event.type === "user_input.requested") return "input";
    if (event.type === "thread.error") return "failed";
    if (event.type === "thread.completed" && event.outcome === "failed") return "failed";
  }
  return null;
}

function bodyFor(kind: AttentionNotificationKind): string {
  if (kind === "approval") return "Agent needs approval.";
  if (kind === "input") return "Agent needs input.";
  return "Agent run needs attention.";
}

export function buildCodingAgentAttentionNotification(input: {
  ownerId: string;
  threadId: string;
  events: AgentThreadEvent[];
}): ChannelReply | null {
  const parsedThreadId = ThreadIdSchema.safeParse(input.threadId);
  if (!parsedThreadId.success) return null;

  const kind = notificationKindFor(input.events);
  if (!kind) return null;

  return {
    channelId: "push",
    chatId: PUSH_CHAT_ID,
    ownerId: input.ownerId,
    text: bodyFor(kind),
    metadata: {
      category: "agent",
      threadId: parsedThreadId.data,
    },
  };
}

export function registerCodingAgentAttentionNotifications(options: CodingAgentAttentionNotificationsOptions): { dispose(): void } {
  return options.threads.registerEventSink(({ ownerId, threadId, events }) => {
    const notification = buildCodingAgentAttentionNotification({ ownerId, threadId, events });
    if (!notification) return;

    void options.send(notification).catch((err: unknown) => {
      console.warn("[coding-agents] attention notification failed:", err instanceof Error ? err.message : String(err));
    });
  });
}
