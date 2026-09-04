import {
  CanonicalChatEventCursorSchema,
  CanonicalChatStreamEventSchema,
  CanonicalChatStreamServerFrameSchema,
  type CanonicalChatStreamEvent,
  type CanonicalChatStreamServerFrame,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOutboxEvent, ChatOwner } from "./records.js";

const DEFAULT_MAX_SUBSCRIBERS = 64;
const DEFAULT_MAX_SUBSCRIBERS_PER_OWNER = 8;
const DEFAULT_SUBSCRIBER_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTACH_BUFFER = 200;
const MAX_SEEN_CURSORS = 500;
const REPLAY_LIMIT = 100;

export interface CanonicalChatEventStreamSink {
  send(frame: CanonicalChatStreamServerFrame): boolean;
  close(): void;
}

export interface CanonicalChatEventStreamSession {
  touch(): void;
  onClose(): void;
}

export interface CanonicalChatEventRepository {
  registerOutboxSink(sink: (input: { owner: ChatOwner; event: ChatOutboxEvent }) => void): {
    dispose(): void;
  };
  replayOutboxWindow(owner: ChatOwner, input: {
    afterCursor?: number;
    limit: number;
  }): Promise<{
    events: ChatOutboxEvent[];
    gap: boolean;
    nextCursor?: number;
  }>;
}

interface Subscriber {
  id: number;
  owner: ChatOwner;
  sink: CanonicalChatEventStreamSink;
  lastTouched: number;
  replaying: boolean;
  buffered: ChatOutboxEvent[];
  seenCursors: Map<number, true>;
}

function safeEvent(event: ChatOutboxEvent): CanonicalChatStreamEvent {
  return CanonicalChatStreamEventSchema.parse({
    cursor: event.cursor,
    chatId: event.chatId,
    revision: event.revision,
    eventType: event.eventType,
    createdAt: event.createdAt,
  });
}

function sendFrame(sink: CanonicalChatEventStreamSink, frame: unknown): boolean {
  try {
    return sink.send(CanonicalChatStreamServerFrameSchema.parse(frame));
  } catch (error: unknown) {
    console.warn("[chat/event-stream] Send failed:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

function closeSink(sink: CanonicalChatEventStreamSink): void {
  try {
    sink.close();
  } catch (error: unknown) {
    console.warn("[chat/event-stream] Close failed:", error instanceof Error ? error.name : "UnknownError");
  }
}

function sameOwner(left: ChatOwner, right: ChatOwner): boolean {
  return left.type === right.type && left.ownerId === right.ownerId;
}

export function createCanonicalChatEventStream(options: {
  repository: CanonicalChatEventRepository;
  maxSubscribers?: number;
  maxSubscribersPerOwner?: number;
  subscriberTtlMs?: number;
  maxAttachBuffer?: number;
  now?: () => number;
}) {
  const subscribers = new Map<number, Subscriber>();
  const maxSubscribers = Math.max(1, Math.min(options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS, DEFAULT_MAX_SUBSCRIBERS));
  const maxSubscribersPerOwner = Math.max(1, Math.min(
    options.maxSubscribersPerOwner ?? DEFAULT_MAX_SUBSCRIBERS_PER_OWNER,
    DEFAULT_MAX_SUBSCRIBERS_PER_OWNER,
  ));
  const subscriberTtlMs = Math.max(1, options.subscriberTtlMs ?? DEFAULT_SUBSCRIBER_TTL_MS);
  const maxAttachBuffer = Math.max(1, Math.min(options.maxAttachBuffer ?? DEFAULT_MAX_ATTACH_BUFFER, DEFAULT_MAX_ATTACH_BUFFER));
  const now = options.now ?? Date.now;
  let nextSubscriberId = 0;
  let shuttingDown = false;

  function evict(id: number, reason?: "server_shutdown"): void {
    const subscriber = subscribers.get(id);
    if (!subscriber) return;
    subscribers.delete(id);
    if (reason === "server_shutdown") {
      sendFrame(subscriber.sink, { type: "chat.stream.closing", reason: "server_shutdown" });
    }
    closeSink(subscriber.sink);
  }

  function sendOrEvict(subscriber: Subscriber, frame: unknown): boolean {
    if (sendFrame(subscriber.sink, frame)) return true;
    evict(subscriber.id);
    return false;
  }

  function evictStaleSubscribers(): void {
    const cutoff = now() - subscriberTtlMs;
    for (const [id, subscriber] of subscribers) {
      if (subscriber.lastTouched < cutoff) evict(id);
    }
  }

  function oldestSubscriber(owner?: ChatOwner): number | undefined {
    let oldest: Subscriber | undefined;
    for (const subscriber of subscribers.values()) {
      if (owner && !sameOwner(owner, subscriber.owner)) continue;
      if (!oldest || subscriber.lastTouched < oldest.lastTouched || (
        subscriber.lastTouched === oldest.lastTouched && subscriber.id < oldest.id
      )) oldest = subscriber;
    }
    return oldest?.id;
  }

  function enforceCaps(owner: ChatOwner): void {
    evictStaleSubscribers();
    while ([...subscribers.values()].filter((subscriber) => sameOwner(owner, subscriber.owner)).length >= maxSubscribersPerOwner) {
      const id = oldestSubscriber(owner);
      if (id === undefined) break;
      evict(id);
    }
    while (subscribers.size >= maxSubscribers) {
      const id = oldestSubscriber();
      if (id === undefined) break;
      evict(id);
    }
  }

  function rememberCursor(subscriber: Subscriber, cursor: number): boolean {
    if (subscriber.seenCursors.has(cursor)) return false;
    subscriber.seenCursors.set(cursor, true);
    while (subscriber.seenCursors.size > MAX_SEEN_CURSORS) {
      const oldest = subscriber.seenCursors.keys().next().value;
      if (typeof oldest !== "number") break;
      subscriber.seenCursors.delete(oldest);
    }
    return true;
  }

  function deliver(subscriber: Subscriber, event: ChatOutboxEvent): boolean {
    if (!rememberCursor(subscriber, event.cursor)) return true;
    try {
      return sendFrame(subscriber.sink, { type: "chat.event", event: safeEvent(event) });
    } catch (error: unknown) {
      console.warn("[chat/event-stream] Invalid outbox metadata:", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }

  function publish(owner: ChatOwner, event: ChatOutboxEvent): void {
    const dead: number[] = [];
    for (const subscriber of subscribers.values()) {
      if (!sameOwner(owner, subscriber.owner)) continue;
      subscriber.lastTouched = now();
      if (subscriber.replaying) {
        if (subscriber.buffered.length >= maxAttachBuffer) {
          dead.push(subscriber.id);
        } else {
          subscriber.buffered.push(event);
        }
      } else if (!deliver(subscriber, event)) {
        dead.push(subscriber.id);
      }
    }
    for (const id of dead) evict(id);
  }

  const sink = options.repository.registerOutboxSink(({ owner, event }) => publish(owner, event));

  async function open(input: {
    sink: CanonicalChatEventStreamSink;
    principal: RequestPrincipal;
    cursor?: number;
  }): Promise<CanonicalChatEventStreamSession> {
    if (shuttingDown) {
      sendFrame(input.sink, { type: "chat.stream.closing", reason: "server_shutdown" });
      closeSink(input.sink);
      return { touch: () => undefined, onClose: () => undefined };
    }
    const cursor = input.cursor === undefined
      ? undefined
      : CanonicalChatEventCursorSchema.parse(input.cursor);
    const owner: ChatOwner = { type: "personal", ownerId: input.principal.userId };
    enforceCaps(owner);
    const subscriber: Subscriber = {
      id: ++nextSubscriberId,
      owner,
      sink: input.sink,
      lastTouched: now(),
      replaying: true,
      buffered: [],
      seenCursors: new Map(),
    };
    subscribers.set(subscriber.id, subscriber);

    try {
      const replay = await options.repository.replayOutboxWindow(owner, {
        ...(cursor === undefined ? {} : { afterCursor: cursor }),
        limit: REPLAY_LIMIT,
      });
      if (!subscribers.has(subscriber.id)) {
        return { touch: () => undefined, onClose: () => undefined };
      }
      if (!sendFrame(input.sink, { type: "chat.stream.attached" })) {
        evict(subscriber.id);
        return { touch: () => undefined, onClose: () => undefined };
      }
      if (replay.gap) {
        if (!sendOrEvict(subscriber, { type: "chat.replay.gap", reason: "cursor_unavailable" })) {
          return { touch: () => undefined, onClose: () => undefined };
        }
        subscriber.buffered = [];
      } else {
        for (const event of replay.events) {
          if (!deliver(subscriber, event)) {
            evict(subscriber.id);
            return { touch: () => undefined, onClose: () => undefined };
          }
        }
      }
      const replayCursor = replay.events.reduce<number | undefined>(
        (highest, event) => highest === undefined ? event.cursor : Math.max(highest, event.cursor),
        undefined,
      );
      const nextCursor = replay.gap
        ? replay.nextCursor
        : replay.nextCursor ?? replayCursor ?? cursor;
      if (!sendFrame(input.sink, {
        type: "chat.replay.end",
        ...(nextCursor === undefined ? {} : { nextCursor }),
      })) {
        evict(subscriber.id);
        return { touch: () => undefined, onClose: () => undefined };
      }
      subscriber.replaying = false;
      const buffered = subscriber.buffered;
      subscriber.buffered = [];
      for (const event of buffered) {
        if (!deliver(subscriber, event)) {
          evict(subscriber.id);
          break;
        }
      }
    } catch (error: unknown) {
      console.warn("[chat/event-stream] Attach failed:", error instanceof Error ? error.name : "UnknownError");
      sendFrame(input.sink, {
        type: "chat.stream.error",
        error: {
          code: "stream_unavailable",
          safeMessage: "Chat stream is temporarily unavailable. Try again.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      });
      evict(subscriber.id);
    }

    return {
      touch() {
        const current = subscribers.get(subscriber.id);
        if (!current) return;
        current.lastTouched = now();
      },
      onClose() {
        subscribers.delete(subscriber.id);
      },
    };
  }

  return {
    open,
    evictStaleSubscribers,
    activeSubscriberCount: () => subscribers.size,
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const id of [...subscribers.keys()]) evict(id, "server_shutdown");
      sink.dispose();
    },
  };
}
