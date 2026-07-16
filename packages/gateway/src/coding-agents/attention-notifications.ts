import {
  CodingAgentAttentionNotificationKindSchema,
  ThreadIdSchema,
  type AgentThreadEvent,
  type CodingAgentAttentionNotificationKind,
} from "@matrix-os/contracts";
import type { ChannelReply } from "../channels/types.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import type { CodingAgentThreadStore } from "./thread-store.js";

const PUSH_CHAT_ID = "coding-agents";
const DEFAULT_DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_MAX_DEDUPE_ENTRIES = 512;

export interface CodingAgentAttentionNotificationSender {
  send(reply: ChannelReply): Promise<void>;
}

export interface CodingAgentAttentionNotificationPreferences {
  isAttentionPushEnabled(input: {
    ownerId: string;
    threadId: string;
    kind: CodingAgentAttentionNotificationKind;
  }): boolean | Promise<boolean>;
}

export interface CodingAgentAttentionNotificationsOptions {
  threads: CodingAgentThreadStore;
  send: (reply: ChannelReply) => Promise<void>;
  preferences?: CodingAgentAttentionNotificationPreferences;
  now?: () => number;
  dedupeWindowMs?: number;
  maxDedupeEntries?: number;
}

function notificationKindFor(events: AgentThreadEvent[]): CodingAgentAttentionNotificationKind | null {
  for (const event of events) {
    if (event.type === "approval.requested") return CodingAgentAttentionNotificationKindSchema.parse("approval");
    if (event.type === "user_input.requested") return CodingAgentAttentionNotificationKindSchema.parse("input");
    if (event.type === "thread.error") return CodingAgentAttentionNotificationKindSchema.parse("failed");
    if (event.type === "thread.completed" && event.outcome === "failed") {
      return CodingAgentAttentionNotificationKindSchema.parse("failed");
    }
    if (event.type === "thread.completed" && event.outcome === "completed") {
      return CodingAgentAttentionNotificationKindSchema.parse("completed");
    }
  }
  return null;
}

function bodyFor(kind: CodingAgentAttentionNotificationKind): string {
  if (kind === "approval") return "Agent needs approval.";
  if (kind === "input") return "Agent needs input.";
  if (kind === "completed") return "Agent run completed.";
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
  const seenAtByKey = new Map<string, number>();
  const now = options.now ?? (() => Date.now());
  const dedupeWindowMs = Math.max(1_000, Math.min(options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS, 10 * 60 * 1000));
  const maxDedupeEntries = Math.max(16, Math.min(options.maxDedupeEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES, 2_048));

  function sweepExpired(currentTime: number): void {
    for (const [key, seenAt] of seenAtByKey) {
      if (currentTime - seenAt > dedupeWindowMs) {
        seenAtByKey.delete(key);
      }
    }
  }

  function remember(key: string, currentTime: number): boolean {
    sweepExpired(currentTime);
    const previous = seenAtByKey.get(key);
    if (previous !== undefined && currentTime - previous <= dedupeWindowMs) {
      return false;
    }
    while (seenAtByKey.size >= maxDedupeEntries) {
      const oldestKey = seenAtByKey.keys().next().value;
      if (!oldestKey) break;
      seenAtByKey.delete(oldestKey);
    }
    seenAtByKey.set(key, currentTime);
    return true;
  }

  const subscription = options.threads.registerEventSink(({ ownerId, threadId, events }) => {
    const kind = notificationKindFor(events);
    if (!kind) return;
    const notification = buildCodingAgentAttentionNotification({ ownerId, threadId, events });
    if (!notification) return;
    const safeNotification = notification;
    const dedupeKey = `${ownerId}:${threadId}:${kind}`;

    function sendIfEligible(): void {
      if (!remember(dedupeKey, now())) return;
      void options.send(safeNotification).catch((err: unknown) => {
        logCodingAgentWarning("attention notification failed", err);
      });
    }

    if (options.preferences) {
      void Promise.resolve(options.preferences.isAttentionPushEnabled({ ownerId, threadId, kind }))
        .then((enabled) => {
          if (!enabled) return;
          sendIfEligible();
        })
        .catch((err: unknown) => {
          logCodingAgentWarning("attention notification preference check failed", err);
        });
      return;
    }

    sendIfEligible();
  });
  return {
    dispose() {
      seenAtByKey.clear();
      subscription.dispose();
    },
  };
}
