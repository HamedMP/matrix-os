import { CanonicalChatStreamServerFrameSchema } from "@matrix-os/contracts";

import { assertSecureTokenTransport } from "@/lib/gateway-client";

export type CanonicalChatInvalidation =
  | { type: "chat.changed"; chatId: string; cursor: number }
  | { type: "chat.full_refresh"; cursor?: number };

type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

function formatAuthorizationHeader(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return /^(Basic|Bearer)\s+/i.test(token) ? token : `Bearer ${token}`;
}

export interface CanonicalChatEventSource {
  subscribe(listener: (event: CanonicalChatInvalidation) => void): () => void;
  connect(): void;
  disconnect(): void;
}

/**
 * Owner-scoped invalidation stream for the Canonical Chat WS
 * (`/ws/chats/events`): frames never carry message content, only "chat X
 * changed at cursor Y" — consumers refetch via REST on each event, matching
 * desktop's `createCanonicalChatEventSource` reconciliation model.
 */
export function createCanonicalChatEventSource(options: {
  wsUrl: string;
  getToken: () => Promise<string | null>;
}): CanonicalChatEventSource {
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
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

  function clearHeartbeat() {
    if (heartbeatTimer === undefined) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== undefined) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  async function connect() {
    if (disposed || socket) return;
    let token: string | null;
    try {
      token = await options.getToken();
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event stream token unavailable",
        error instanceof Error ? error.name : "UnknownError",
      );
      scheduleReconnect();
      return;
    }
    if (disposed || socket) return;

    let url: URL;
    try {
      url = new URL(options.wsUrl);
      if (lastCursor !== undefined) url.searchParams.set("cursor", String(lastCursor));
    } catch {
      scheduleReconnect();
      return;
    }

    const authorization = formatAuthorizationHeader(token ?? undefined);
    const WebSocketWithOptions = WebSocket as unknown as ReactNativeWebSocketConstructor;
    const ws = new WebSocketWithOptions(
      url.toString(),
      [],
      authorization ? { headers: { Authorization: authorization } } : undefined,
    );
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      reconnectAttempts = 0;
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (socket !== ws) return;
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch (error: unknown) {
          console.warn(
            "[canonical-chat] event stream heartbeat failed",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (message) => {
      if (socket !== ws || typeof message.data !== "string") return;
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = CanonicalChatStreamServerFrameSchema.safeParse(value);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "chat.replay.end") {
        lastCursor = frame.nextCursor;
        return;
      }
      if (frame.type === "chat.event") {
        lastCursor = frame.event.cursor;
        emit({ type: "chat.changed", chatId: frame.event.chatId, cursor: frame.event.cursor });
        return;
      }
      if (frame.type === "chat.stream.closing") {
        ws.close();
      }
    };

    ws.onerror = () => {
      console.warn("[canonical-chat] event stream connection failed");
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      clearHeartbeat();
      scheduleReconnect();
    };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect() {
      try {
        assertSecureTokenTransport(options.wsUrl.replace(/^ws/, "http"));
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
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      clearHeartbeat();
      const current = socket;
      socket = null;
      if (current) {
        current.onopen = null;
        current.onmessage = null;
        current.onerror = null;
        current.onclose = null;
        try {
          current.close();
        } catch (error: unknown) {
          console.warn(
            "[canonical-chat] event stream close failed",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }
      listeners.clear();
    },
  };
}
