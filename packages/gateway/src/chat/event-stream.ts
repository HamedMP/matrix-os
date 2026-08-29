import {
  CanonicalChatEventCursorSchema,
  CanonicalChatStreamClientFrameSchema,
  CanonicalChatStreamEventSchema,
  CanonicalChatStreamServerFrameSchema,
  SafeClientErrorSchema,
  type CanonicalChatStreamEvent,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOutboxEvent, ChatOwner } from "./records.js";

const MAX_INBOUND_FRAME_BYTES = 4096;
const DEFAULT_MAX_SUBSCRIBERS = 64;
const DEFAULT_MAX_SUBSCRIBERS_PER_OWNER = 8;
const DEFAULT_SUBSCRIBER_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTACH_BUFFER = 200;
const MAX_SEEN_CURSORS = 500;
const REPLAY_LIMIT = 100;

export interface CanonicalChatEventStreamSocket {
  send(data: string): void;
  close(): void;
}

export interface CanonicalChatEventStreamSession {
  onMessage(raw: string): void;
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
  ws: CanonicalChatEventStreamSocket;
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

function invalidFrameError() {
  return SafeClientErrorSchema.parse({
    code: "invalid_frame",
    safeMessage: "Stream message was invalid. Refresh and try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function sendJson(ws: CanonicalChatEventStreamSocket, frame: unknown): boolean {
  try {
    ws.send(JSON.stringify(CanonicalChatStreamServerFrameSchema.parse(frame)));
    return true;
  } catch (error: unknown) {
    console.warn("[chat/event-stream] Send failed:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

function closeSocket(ws: CanonicalChatEventStreamSocket): void {
  try {
    ws.close();
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
      sendJson(subscriber.ws, { type: "chat.stream.closing", reason: "server_shutdown" });
    }
    closeSocket(subscriber.ws);
  }

  function sendOrEvict(subscriber: Subscriber, frame: unknown): boolean {
    if (sendJson(subscriber.ws, frame)) return true;
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
      return sendJson(subscriber.ws, { type: "chat.event", event: safeEvent(event) });
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
    ws: CanonicalChatEventStreamSocket;
    principal: RequestPrincipal;
    cursor?: number;
  }): Promise<CanonicalChatEventStreamSession> {
    if (shuttingDown) {
      sendJson(input.ws, { type: "chat.stream.closing", reason: "server_shutdown" });
      closeSocket(input.ws);
      return { onMessage: () => undefined, onClose: () => undefined };
    }
    const cursor = input.cursor === undefined
      ? undefined
      : CanonicalChatEventCursorSchema.parse(input.cursor);
    const owner: ChatOwner = { type: "personal", ownerId: input.principal.userId };
    enforceCaps(owner);
    const subscriber: Subscriber = {
      id: ++nextSubscriberId,
      owner,
      ws: input.ws,
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
        return { onMessage: () => undefined, onClose: () => undefined };
      }
      if (!sendJson(input.ws, { type: "chat.stream.attached" })) {
        evict(subscriber.id);
        return { onMessage: () => undefined, onClose: () => undefined };
      }
      if (replay.gap) {
        if (!sendOrEvict(subscriber, { type: "chat.replay.gap", reason: "cursor_unavailable" })) {
          return { onMessage: () => undefined, onClose: () => undefined };
        }
        subscriber.buffered = [];
      } else {
        for (const event of replay.events) {
          if (!deliver(subscriber, event)) {
            evict(subscriber.id);
            return { onMessage: () => undefined, onClose: () => undefined };
          }
        }
      }
      const nextCursor = replay.gap ? replay.nextCursor : replay.nextCursor ?? cursor;
      if (!sendJson(input.ws, {
        type: "chat.replay.end",
        ...(nextCursor === undefined ? {} : { nextCursor }),
      })) {
        evict(subscriber.id);
        return { onMessage: () => undefined, onClose: () => undefined };
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
      sendJson(input.ws, {
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
      onMessage(raw) {
        const current = subscribers.get(subscriber.id);
        if (!current) return;
        current.lastTouched = now();
        if (!canonicalChatEventFrameWithinLimit(raw)) {
          sendOrEvict(current, { type: "chat.stream.error", error: invalidFrameError() });
          evict(current.id);
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) {
            console.warn(
              "[chat/event-stream] JSON parse failed:",
              error instanceof Error ? error.name : "UnknownError",
            );
          }
          sendOrEvict(current, { type: "chat.stream.error", error: invalidFrameError() });
          return;
        }
        const frame = CanonicalChatStreamClientFrameSchema.safeParse(value);
        if (!frame.success) {
          sendOrEvict(current, { type: "chat.stream.error", error: invalidFrameError() });
          return;
        }
        if (frame.data.type === "ping") {
          sendOrEvict(current, { type: "pong" });
        } else {
          evict(current.id);
        }
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

export function chatEventFrameDataToString(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

export function canonicalChatEventFrameWithinLimit(raw: string): boolean {
  return Buffer.byteLength(raw, "utf8") <= MAX_INBOUND_FRAME_BYTES;
}

export function canonicalChatEventFrameDataWithinLimit(data: unknown): boolean {
  if (typeof data === "string") return canonicalChatEventFrameWithinLimit(data);
  if (Buffer.isBuffer(data)) return data.byteLength <= MAX_INBOUND_FRAME_BYTES;
  if (data instanceof ArrayBuffer) return data.byteLength <= MAX_INBOUND_FRAME_BYTES;
  if (ArrayBuffer.isView(data)) return data.byteLength <= MAX_INBOUND_FRAME_BYTES;
  return false;
}
