import {
  CanonicalChatTransportFrameSchema,
  type CanonicalChatContentFrame,
  type CanonicalChatStreamEvent,
} from "@matrix-os/contracts";
// React Native's own fetch only resolves once the whole body has arrived;
// expo/fetch exposes the body as a stream, which a live event stream needs.
import { fetch as streamingFetch } from "expo/fetch";

import { assertSecureTokenTransport } from "@/lib/gateway-client";
import { buildGatewayRequestUrl } from "@/lib/requests/http";

export type CanonicalChatInvalidation =
  | {
      type: "chat.changed";
      chatId: string;
      cursor: number;
      eventType: CanonicalChatStreamEvent["eventType"];
      /** The change itself, when the server streamed it -- apply it instead of refetching. */
      content?: CanonicalChatContentFrame;
    }
  | { type: "chat.full_refresh"; cursor?: number };

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// A connection has to hold this long before the next drop reconnects at the
// base delay again. Attaching alone is not proof it works: a stream that is
// accepted and then cut straight away would otherwise be reopened every second.
const STABLE_CONNECTION_MS = 10_000;
// The gateway writes a heartbeat every 15s, so this much silence means the
// connection is dead even if the socket never reported it.
const INACTIVITY_TIMEOUT_MS = 45_000;
// The gateway caps one event at 512 KiB; more than this without a complete
// event is not something we can parse.
const MAX_BUFFERED_CHARS = 1024 * 1024;
// Real usage is a handful of mounted consumers at most; this guards against a
// subscribe-without-unsubscribe leak growing the registry unbounded.
const MAX_LISTENERS = 50;

export interface CanonicalChatEventSource {
  subscribe(listener: (event: CanonicalChatInvalidation) => void): () => void;
  /**
   * Reports `true` once the stream has caught up and is delivering changes as
   * they happen, and `false` when that connection is lost. Consumers use it to
   * fall back to polling only while the stream is down.
   */
  subscribeLive(listener: (live: boolean) => void): () => void;
  connect(): void;
  disconnect(): void;
}

/**
 * Owner-scoped Canonical Chat event stream (`GET /api/chats/events`, served as
 * Server-Sent Events). Protocol 2 frames carry the changed content itself --
 * including each newly generated piece of assistant text -- so consumers can
 * patch what they hold instead of refetching, matching desktop's
 * `createCanonicalChatEventSource`. Frames without content stay plain
 * "chat X changed" invalidations that consumers refetch via REST.
 */
export function createCanonicalChatEventSource(options: {
  /** The computer's gateway base, as used for every other chat REST call. */
  gatewayUrl: string;
  getToken: () => Promise<string | null>;
}): CanonicalChatEventSource {
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  const liveListeners = new Set<(live: boolean) => void>();
  let live = false;
  let attachedAt: number | undefined;
  let streamUrl = "";
  let connection: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let lastCursor: number | undefined;
  let disposed = false;

  function emit(event: CanonicalChatInvalidation) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.warn(
          "[canonical-chat] event listener failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
  }

  function setLive(next: boolean) {
    if (live === next) return;
    live = next;
    for (const listener of liveListeners) {
      try {
        listener(next);
      } catch (error: unknown) {
        console.warn(
          "[canonical-chat] stream state listener failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== undefined) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }

  /** Ends `current` if it is still the live connection, then retries. */
  function drop(current: AbortController) {
    if (connection !== current) return;
    connection = null;
    clearTimeout(inactivityTimer);
    current.abort();
    setLive(false);
    if (attachedAt !== undefined && Date.now() - attachedAt >= STABLE_CONNECTION_MS) reconnectAttempts = 0;
    attachedAt = undefined;
    scheduleReconnect();
  }

  function watchForSilence(current: AbortController) {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => drop(current), INACTIVITY_TIMEOUT_MS);
  }

  /**
   * One SSE record: an optional `id:` line plus a `data:` line holding a JSON
   * frame. Every connection opens with a replay of past events, which ends
   * with `chat.replay.end`. `replay.missedEvents` is set while that replay
   * replayed or skipped events, so its end can reconcile once from REST.
   */
  function handleRecord(record: string, replay: { complete: boolean; missedEvents: boolean }) {
    const data = record.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length);
    if (!data) return; // Heartbeats are comment-only records.

    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event stream sent invalid JSON",
        error instanceof Error ? error.name : "UnknownError",
      );
      return;
    }
    const parsed = CanonicalChatTransportFrameSchema.safeParse(value);
    if (!parsed.success) {
      console.warn("[canonical-chat] event stream sent an unknown frame");
      return;
    }

    const frame = parsed.data;
    if (frame.type === "chat.stream.attached") {
      attachedAt = Date.now();
    } else if (frame.type === "chat.replay.gap") {
      // The server has more past events than it replays, so it skipped them.
      // That can happen on a first connection too, not only after a resume.
      replay.missedEvents = true;
    } else if (frame.type === "chat.replay.end") {
      if (frame.nextCursor !== undefined) lastCursor = frame.nextCursor;
      if (replay.missedEvents) emit({ type: "chat.full_refresh" });
      replay.missedEvents = false;
      replay.complete = true;
      setLive(true);
    } else if (frame.type === "chat.event" || frame.type === "chat.content") {
      lastCursor = Math.max(lastCursor ?? 0, frame.event.cursor);
      if (!replay.complete && frame.type === "chat.event") {
        // Replayed events only say that chats changed in the past. The replay
        // can hold a hundred of them, so they become the one refresh at its
        // end instead of a refetch each -- as desktop's event source does.
        replay.missedEvents = true;
        return;
      }
      emit({
        type: "chat.changed",
        chatId: frame.event.chatId,
        cursor: frame.event.cursor,
        eventType: frame.event.eventType,
        ...(frame.type === "chat.content" ? { content: frame } : {}),
      });
    }
    // After `chat.stream.closing` / `chat.stream.error` the server ends the
    // response, which reconnects below.
  }

  async function connect() {
    if (disposed || connection) return;
    const current = new AbortController();
    connection = current;
    // Changes committed while we were disconnected may not all be replayed in
    // order, so every resume reconciles once from REST when its replay ends.
    const replay = { complete: false, missedEvents: lastCursor !== undefined };
    // Also bounds the wait for response headers, not just gaps between events.
    watchForSilence(current);
    try {
      const token = await options.getToken();
      if (!token) throw new Error("ChatEventTokenUnavailable");
      const response = await streamingFetch(streamUrl, {
        headers: {
          Accept: "text/event-stream",
          // Protocol 1 only says "chat X changed"; protocol 2 includes the content.
          "X-Matrix-Chat-Protocol": "2",
          Authorization: `Bearer ${token}`,
          ...(lastCursor === undefined ? {} : { "Last-Event-ID": String(lastCursor) }),
        },
        signal: current.signal,
      });
      if (!response.ok || !response.body) throw new Error("ChatEventStreamUnavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (connection === current) {
        const { done, value } = await reader.read();
        if (done || connection !== current) break;
        watchForSilence(current);
        buffered += decoder.decode(value, { stream: true });
        // Records end with a blank line; the tail stays buffered until the
        // rest of it arrives in a later chunk.
        const records = buffered.split("\n\n");
        buffered = records.pop() ?? "";
        if (buffered.length > MAX_BUFFERED_CHARS) throw new Error("ChatEventFrameTooLarge");
        for (const record of records) handleRecord(record, replay);
      }
    } catch (error: unknown) {
      if (connection === current) {
        console.warn(
          "[canonical-chat] event stream unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    } finally {
      drop(current);
    }
  }

  return {
    subscribe(listener) {
      if (listeners.size >= MAX_LISTENERS) {
        const oldest = listeners.values().next().value;
        if (oldest) listeners.delete(oldest);
        console.warn("[canonical-chat] event listener cap reached, evicting oldest subscriber");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeLive(listener) {
      if (liveListeners.size >= MAX_LISTENERS) {
        const oldest = liveListeners.values().next().value;
        if (oldest) liveListeners.delete(oldest);
        console.warn("[canonical-chat] stream state listener cap reached, evicting oldest subscriber");
      }
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    connect() {
      try {
        streamUrl = buildGatewayRequestUrl(options.gatewayUrl, "/api/chats/events", { fundingVersion: "1" });
        assertSecureTokenTransport(streamUrl);
      } catch (error: unknown) {
        console.warn(
          "[canonical-chat] event stream origin rejected",
          error instanceof Error ? error.message : "unavailable",
        );
        return;
      }
      void connect();
    },
    disconnect() {
      disposed = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearTimeout(inactivityTimer);
      connection?.abort();
      connection = null;
      setLive(false);
      listeners.clear();
      liveListeners.clear();
    },
  };
}
