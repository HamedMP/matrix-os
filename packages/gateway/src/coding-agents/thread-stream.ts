import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  SafeClientErrorSchema,
  ThreadIdSchema,
  type AgentThreadEvent,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import {
  CodingAgentThreadError,
  safeThreadError,
  type CodingAgentThreadStore,
} from "./thread-store.js";
import { logCodingAgentWarning } from "./diagnostics.js";

const MAX_INBOUND_FRAME_BYTES = 4096;
const DEFAULT_MAX_SUBSCRIBERS = 64;
const DEFAULT_SUBSCRIBER_TTL_MS = 5 * 60 * 1000;
const MAX_BUFFERED_ATTACH_EVENTS = 200;

const ThreadStreamClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }).strict(),
  z.object({ type: z.literal("detach") }).strict(),
]);

export interface CodingAgentThreadStreamSocket {
  send(data: string): void;
  close?: () => void;
}

export interface CodingAgentThreadStreamSession {
  onMessage(raw: string): void;
  onClose(): void;
}

export interface CodingAgentThreadStreamOptions {
  threads: CodingAgentThreadStore;
  maxSubscribers?: number;
  subscriberTtlMs?: number;
  now?: () => number;
}

interface Subscriber {
  id: string;
  ownerId: string;
  threadId: string;
  ws: CodingAgentThreadStreamSocket;
  lastTouched: number;
  replaying: boolean;
  bufferedEvents: AgentThreadEvent[];
}

export function threadStreamFrameDataToString(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

function invalidFrameError() {
  return SafeClientErrorSchema.parse({
    code: "invalid_frame",
    safeMessage: "Stream message was invalid. Refresh and try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function sendJson(ws: CodingAgentThreadStreamSocket, frame: unknown): boolean {
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (err: unknown) {
    logCodingAgentWarning("thread stream send failed", err);
    return false;
  }
}

function closeSocket(ws: CodingAgentThreadStreamSocket): void {
  try {
    ws.close?.();
  } catch (err: unknown) {
    logCodingAgentWarning("thread stream close failed", err);
  }
}

export function createCodingAgentThreadStream(options: CodingAgentThreadStreamOptions) {
  const subscribers = new Map<string, Subscriber>();
  const maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  const subscriberTtlMs = options.subscriberTtlMs ?? DEFAULT_SUBSCRIBER_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let nextSubscriberId = 0;
  let shuttingDown = false;

  const eventSink = options.threads.registerEventSink(({ ownerId, threadId, events }) => {
    broadcast(ownerId, threadId, events);
  });

  function evictSubscriber(id: string, reason?: "subscriber_cap" | "stale" | "send_failed" | "server_shutdown"): void {
    const subscriber = subscribers.get(id);
    if (!subscriber) return;
    subscribers.delete(id);
    if (reason === "server_shutdown") {
      sendJson(subscriber.ws, { type: "thread.stream.closing", reason: "server_shutdown" });
    }
    closeSocket(subscriber.ws);
  }

  function evictStaleSubscribers(): void {
    const cutoff = now() - subscriberTtlMs;
    for (const [id, subscriber] of subscribers) {
      if (subscriber.lastTouched < cutoff) {
        evictSubscriber(id, "stale");
      }
    }
  }

  function enforceSubscriberCap(): void {
    evictStaleSubscribers();
    while (subscribers.size >= maxSubscribers) {
      let oldestId: string | null = null;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [id, subscriber] of subscribers) {
        if (subscriber.lastTouched < oldestTouched) {
          oldestId = id;
          oldestTouched = subscriber.lastTouched;
        }
      }
      if (!oldestId) return;
      evictSubscriber(oldestId, "subscriber_cap");
    }
  }

  function broadcast(ownerId: string, threadId: string, events: AgentThreadEvent[]): void {
    const deadSubscriberIds: string[] = [];
    for (const [id, subscriber] of subscribers) {
      if (subscriber.ownerId !== ownerId || subscriber.threadId !== threadId) {
        continue;
      }
      subscriber.lastTouched = now();
      if (subscriber.replaying) {
        subscriber.bufferedEvents.push(...events.map((event) => AgentThreadEventSchema.parse(event)));
        if (subscriber.bufferedEvents.length > MAX_BUFFERED_ATTACH_EVENTS) {
          deadSubscriberIds.push(id);
        }
        continue;
      }
      for (const event of events) {
        const parsed = AgentThreadEventSchema.parse(event);
        if (!sendJson(subscriber.ws, { type: "thread.event", event: parsed })) {
          deadSubscriberIds.push(id);
          break;
        }
      }
    }
    for (const id of deadSubscriberIds) {
      evictSubscriber(id, "send_failed");
    }
  }

  async function open(input: {
    ws: CodingAgentThreadStreamSocket;
    principal: RequestPrincipal;
    threadId: string;
    cursor?: string;
  }): Promise<CodingAgentThreadStreamSession> {
    let threadId: string;
    let openedSubscriberId: string | null = null;
    try {
      if (shuttingDown) {
        sendJson(input.ws, { type: "thread.stream.closing", reason: "server_shutdown" });
        closeSocket(input.ws);
        return { onMessage: () => undefined, onClose: () => undefined };
      }
      threadId = ThreadIdSchema.parse(input.threadId);
      enforceSubscriberCap();
      const id = `thread_sub_${++nextSubscriberId}`;
      const subscriber: Subscriber = {
        id,
        ownerId: input.principal.userId,
        threadId,
        ws: input.ws,
        lastTouched: now(),
        replaying: true,
        bufferedEvents: [],
      };
      subscribers.set(id, subscriber);
      openedSubscriberId = id;

      const snapshot = await options.threads.getThread(input.principal, threadId, input.cursor);
      const currentSubscriber = subscribers.get(id);
      if (!currentSubscriber) {
        return { onMessage: () => undefined, onClose: () => undefined };
      }

      if (!sendJson(input.ws, { type: "thread.stream.attached", threadId })) {
        evictSubscriber(id, "send_failed");
        return { onMessage: () => undefined, onClose: () => undefined };
      }
      const replayedEventIds = snapshot.events.items.map((event) => event.eventId);
      for (const event of snapshot.events.items) {
        if (!sendJson(input.ws, { type: "thread.event", event })) {
          evictSubscriber(id, "send_failed");
          return { onMessage: () => undefined, onClose: () => undefined };
        }
      }
      sendJson(input.ws, { type: "thread.replay.end", nextCursor: snapshot.events.nextCursor });
      currentSubscriber.replaying = false;
      const bufferedEvents = currentSubscriber.bufferedEvents.filter((event) => !replayedEventIds.includes(event.eventId));
      currentSubscriber.bufferedEvents = [];
      broadcast(input.principal.userId, threadId, bufferedEvents);

      return {
        onMessage(raw) {
          const current = subscribers.get(id);
          if (!current) return;
          current.lastTouched = now();
          if (Buffer.byteLength(raw, "utf8") > MAX_INBOUND_FRAME_BYTES) {
            sendJson(input.ws, { type: "thread.stream.error", error: invalidFrameError() });
            evictSubscriber(id, "send_failed");
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err: unknown) {
            if (!(err instanceof SyntaxError)) {
              logCodingAgentWarning("thread stream JSON parse failed", err);
            }
            sendJson(input.ws, { type: "thread.stream.error", error: invalidFrameError() });
            return;
          }
          const frame = ThreadStreamClientFrameSchema.safeParse(parsed);
          if (!frame.success) {
            sendJson(input.ws, { type: "thread.stream.error", error: invalidFrameError() });
            return;
          }
          if (frame.data.type === "ping") {
            sendJson(input.ws, { type: "pong" });
            return;
          }
          evictSubscriber(id);
        },
        onClose() {
          subscribers.delete(id);
        },
      };
    } catch (err: unknown) {
      if (openedSubscriberId) {
        subscribers.delete(openedSubscriberId);
      }
      const safeError = err instanceof CodingAgentThreadError
        ? safeThreadError(err.code)
        : SafeClientErrorSchema.parse({
          code: "thread_stream_unavailable",
          safeMessage: "Thread stream is temporarily unavailable. Try again.",
          retryable: true,
          recoveryActions: ["retry"],
        });
      if (!(err instanceof CodingAgentThreadError)) {
        logCodingAgentWarning("thread stream open failed", err);
      }
      sendJson(input.ws, { type: "thread.stream.error", error: safeError });
      closeSocket(input.ws);
      return { onMessage: () => undefined, onClose: () => undefined };
    }
  }

  function shutdown(): void {
    shuttingDown = true;
    for (const id of Array.from(subscribers.keys())) {
      evictSubscriber(id, "server_shutdown");
    }
    eventSink.dispose();
  }

  return {
    open,
    evictStaleSubscribers,
    shutdown,
    activeSubscriberCount: () => subscribers.size,
  };
}
