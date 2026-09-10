import { fetch as expoFetch } from "expo/fetch";
import type { AppStateStatus } from "react-native";
import {
  CanonicalChatTransportFrameSchema,
  type CanonicalChatContentFrame,
  type CanonicalChatOutboxEventType,
} from "@matrix-os/contracts/canonical-chat-streaming";

import { assertSecureTokenTransport } from "@/lib/gateway-client";

export type CanonicalChatInvalidation =
  | {
      type: "chat.changed";
      chatId: string;
      cursor: number;
      revision: number;
      eventType: CanonicalChatOutboxEventType;
      content?: CanonicalChatContentFrame;
    }
  | { type: "chat.full_refresh"; cursor?: number };

export interface CanonicalChatEventSource {
  subscribe(listener: (event: CanonicalChatInvalidation) => void): () => void;
  start(): Promise<void>;
  reconnect(): Promise<void>;
  dispose(): void;
}

interface AppStateSource {
  currentState: AppStateStatus;
  addEventListener(
    type: "change",
    listener: (state: AppStateStatus) => void,
  ): { remove(): void };
}

export function reconnectCanonicalChatOnForeground(
  source: Pick<CanonicalChatEventSource, "reconnect">,
  appState: AppStateSource,
): { remove(): void } {
  let previous = appState.currentState;
  return appState.addEventListener("change", (next) => {
    const foregrounded = next === "active" && previous !== "active";
    previous = next;
    if (foregrounded) void source.reconnect();
  });
}

interface StreamResponse {
  ok: boolean;
  headers: Pick<Headers, "get">;
  body: ReadableStream<Uint8Array> | null;
}
type StreamFetch = (url: string, init: RequestInit) => Promise<StreamResponse>;

const MAX_LISTENERS = 50;
const MAX_SEEN_CURSORS = 500;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_RECONNECT_DELAY_MS = 10_000;
const INACTIVITY_TIMEOUT_MS = 45_000;
const CONNECTION_LIFETIME_MS = 5 * 60_000;

function authorizationHeader(token: string): string {
  return /^(Basic|Bearer)\s+/i.test(token) ? token : `Bearer ${token}`;
}

function eventStreamUrl(raw: string): string {
  assertSecureTokenTransport(raw);
  const url = new URL(raw);
  url.searchParams.set("messageVersion", "2");
  return url.toString();
}

function createSseParser(options: {
  onData(data: string): void;
  onActivity(): void;
}): { push(chunk: Uint8Array): void; finish(): void } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let eventBytes = 0;
  let dataLines: string[] = [];

  const resetRecord = () => {
    eventBytes = 0;
    dataLines = [];
  };
  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = encoder.encode(line).byteLength + 1;
    if (lineBytes > MAX_EVENT_BYTES || eventBytes + lineBytes > MAX_EVENT_BYTES) {
      throw new Error("ChatEventFrameTooLarge");
    }
    eventBytes += lineBytes;
    if (line === "") {
      if (dataLines.length > 0) options.onData(dataLines.join("\n"));
      resetRecord();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") dataLines.push(value);
  };
  const consumeText = (text: string) => {
    pending += text;
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      consumeLine(line);
    }
    if (encoder.encode(pending).byteLength + eventBytes > MAX_EVENT_BYTES) {
      throw new Error("ChatEventFrameTooLarge");
    }
  };
  return {
    push(chunk) {
      if (chunk.byteLength === 0) return;
      options.onActivity();
      consumeText(decoder.decode(chunk, { stream: true }));
    },
    finish() { consumeText(decoder.decode()); },
  };
}

/**
 * Expo SDK 57 installs `expo/fetch` as the native global fetch implementation.
 * Its streamed response body lets Native Mobile consume the same authenticated
 * protocol-v2 SSE contract as Web and Electron without widening the legacy WS.
 */
export function createCanonicalChatEventSource(options: {
  url: string;
  getToken: () => Promise<string | null>;
  fetchFn?: StreamFetch;
  setTimeoutFn?: (callback: () => void, delay: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}): CanonicalChatEventSource {
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  const seenCursors = new Map<number, true>();
  const fetchFn: StreamFetch = options.fetchFn ?? expoFetch;
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let disposed = false;
  let started = false;
  let generation = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown;
  let inactivityTimer: unknown;
  let rotationTimer: unknown;
  let controller: AbortController | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let lastCursor: number | undefined;

  const emit = (event: CanonicalChatInvalidation) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.warn("[canonical-chat] event listener failed:", error instanceof Error ? error.name : "UnknownError");
      }
    }
  };
  const rememberCursor = (cursor: number) => {
    if (seenCursors.has(cursor)) return false;
    seenCursors.set(cursor, true);
    while (seenCursors.size > MAX_SEEN_CURSORS) {
      const oldest = seenCursors.keys().next().value;
      if (typeof oldest !== "number") break;
      seenCursors.delete(oldest);
    }
    return true;
  };
  const clearConnectionTimers = () => {
    if (inactivityTimer !== undefined) clearTimeoutFn(inactivityTimer);
    if (rotationTimer !== undefined) clearTimeoutFn(rotationTimer);
    inactivityTimer = undefined;
    rotationTimer = undefined;
  };
  const stopConnection = () => {
    clearConnectionTimers();
    const activeReader = reader;
    reader = undefined;
    if (activeReader) {
      void activeReader.cancel().catch((error: unknown) => {
        console.warn("[canonical-chat] event reader cancel failed:", error instanceof Error ? error.name : "UnknownError");
      });
    }
    controller?.abort();
    controller = undefined;
  };
  const resetInactivity = (connectionGeneration: number) => {
    if (inactivityTimer !== undefined) clearTimeoutFn(inactivityTimer);
    inactivityTimer = setTimeoutFn(() => {
      if (!disposed && generation === connectionGeneration) scheduleReconnect();
    }, INACTIVITY_TIMEOUT_MS);
  };
  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return;
    stopConnection();
    const delay = Math.min(250 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };
  const handleData = (
    raw: string,
    replay: { complete: boolean; gap: boolean; sawMetadata: boolean },
  ) => {
    const parsed = CanonicalChatTransportFrameSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("InvalidChatEventFrame");
    const frame = parsed.data;
    if (frame.type === "chat.stream.attached") {
      reconnectAttempt = 0;
      return;
    }
    if (frame.type === "chat.replay.gap") {
      replay.gap = true;
      return;
    }
    if (frame.type === "chat.replay.end") {
      if (frame.nextCursor !== undefined) {
        lastCursor = lastCursor === undefined ? frame.nextCursor : Math.max(lastCursor, frame.nextCursor);
      }
      if (replay.gap || replay.sawMetadata) {
        emit({ type: "chat.full_refresh", ...(frame.nextCursor === undefined ? {} : { cursor: frame.nextCursor }) });
      }
      replay.complete = true;
      replay.gap = false;
      return;
    }
    if (frame.type === "chat.event" || frame.type === "chat.content") {
      lastCursor = lastCursor === undefined ? frame.event.cursor : Math.max(lastCursor, frame.event.cursor);
      if (!rememberCursor(frame.event.cursor)) return;
      if (!replay.complete && frame.type === "chat.event") replay.sawMetadata = true;
      emit({
        type: "chat.changed",
        chatId: frame.event.chatId,
        cursor: frame.event.cursor,
        revision: frame.event.revision,
        eventType: frame.event.eventType,
        ...(frame.type === "chat.content" ? { content: frame } : {}),
      });
      return;
    }
    if (frame.type === "chat.stream.closing"
      || (frame.type === "chat.stream.error" && frame.error.retryable)) scheduleReconnect();
  };

  async function connect(): Promise<void> {
    if (disposed) return;
    const connectionGeneration = ++generation;
    stopConnection();
    const nextController = new AbortController();
    controller = nextController;
    // Bound token lookup and the HTTP handshake as well as the established
    // stream. A server that never returns headers must not pin this source.
    resetInactivity(connectionGeneration);
    try {
      const token = await options.getToken();
      if (!token) throw new Error("ChatAuthUnavailable");
      if (disposed || generation !== connectionGeneration) return;
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        Authorization: authorizationHeader(token),
        "X-Matrix-Chat-Protocol": "2",
        ...(lastCursor === undefined ? {} : { "Last-Event-ID": String(lastCursor) }),
      };
      const response = await fetchFn(eventStreamUrl(options.url), {
        method: "GET",
        headers,
        signal: nextController.signal,
      });
      if (disposed || generation !== connectionGeneration) {
        nextController.abort();
        return;
      }
      if (!response.ok
        || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
        || !response.body) throw new Error("InvalidChatEventResponse");

      resetInactivity(connectionGeneration);
      rotationTimer = setTimeoutFn(() => {
        if (!disposed && generation === connectionGeneration) scheduleReconnect();
      }, CONNECTION_LIFETIME_MS);
      const replay = { complete: false, gap: false, sawMetadata: false };
      const parser = createSseParser({
        onActivity: () => resetInactivity(connectionGeneration),
        onData: (data) => handleData(data, replay),
      });
      const nextReader = response.body.getReader();
      reader = nextReader;
      void (async () => {
        try {
          while (!disposed && generation === connectionGeneration) {
            const next = await nextReader.read();
            if (next.done) break;
            parser.push(next.value);
          }
          parser.finish();
        } catch (error: unknown) {
          if (!nextController.signal.aborted) {
            console.warn("[canonical-chat] event stream read failed:", error instanceof Error ? error.name : "UnknownError");
          }
        } finally {
          if (reader === nextReader) reader = undefined;
          try {
            nextReader.releaseLock();
          } catch (error: unknown) {
            console.warn("[canonical-chat] event reader release failed:", error instanceof Error ? error.name : "UnknownError");
          }
          if (!disposed && generation === connectionGeneration) scheduleReconnect();
        }
      })();
    } catch (error: unknown) {
      if (!disposed && generation === connectionGeneration) {
        console.warn("[canonical-chat] event stream unavailable:", error instanceof Error ? error.name : "UnknownError");
        scheduleReconnect();
      }
    }
  }

  return {
    subscribe(listener) {
      if (disposed) throw new Error("Chat event source is disposed");
      if (listeners.size >= MAX_LISTENERS) {
        const oldest = listeners.values().next().value;
        if (oldest) listeners.delete(oldest);
        console.warn("[canonical-chat] event listener cap reached, evicting oldest subscriber");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (started || disposed) return;
      started = true;
      await connect();
    },
    async reconnect() {
      if (disposed || !started) return;
      if (reconnectTimer !== undefined) clearTimeoutFn(reconnectTimer);
      reconnectTimer = undefined;
      stopConnection();
      await connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (reconnectTimer !== undefined) clearTimeoutFn(reconnectTimer);
      reconnectTimer = undefined;
      stopConnection();
      seenCursors.clear();
      listeners.clear();
    },
  };
}
