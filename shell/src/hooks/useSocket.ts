"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";
import { createSocketHealth, MessageQueue, reconnectDelay } from "@/lib/socket-health";
import { classifySocketClose, recordConnectionDiagnostic } from "@/lib/connection-diagnostics";
import { capturePostHogEvent } from "@/lib/posthog-client";
import { setConnectionHealthState, useConnectionHealth } from "./useConnectionHealth";
import type { ConnectionState } from "./useConnectionHealth";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string; eventId?: string }
  | { type: "kernel:text"; text: string; requestId?: string; eventId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string; eventId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string; eventId?: string }
  | { type: "kernel:result"; data: Record<string, unknown>; requestId?: string; eventId?: string }
  | { type: "kernel:error"; message: string; requestId?: string; eventId?: string }
  | { type: "kernel:aborted"; requestId?: string; eventId?: string }
  | { type: "file:change"; path: string; event: "add" | "change" | "unlink" }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number }
  | { type: "data:change"; app: string; key: string }
  | {
      type: "client:ack";
      actionId: string;
      actionType: string;
      status: "accepted" | "rejected";
      retryable?: boolean;
    }
  | { type: "pong" };

type MessageHandler = (msg: ServerMessage) => void;
export type DeliveryState = "queued" | "sent" | "accepted" | "failed";

export interface DeliverySnapshot {
  id: string;
  type: string;
  state: DeliveryState;
  retryable: boolean;
  updatedAt: number;
}

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const MAX_RECONNECT_ATTEMPTS = 60;
let globalSocket: WebSocket | null = null;
let handlers = new Set<MessageHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let connectionState: ConnectionState = "initializing";
let hasOpenedSocket = false;
let connectionEpoch = 0;
let reconnectStartedAt: number | null = null;
let stateListeners = new Set<() => void>();
let healthUnsubscribe: (() => void) | null = null;
const deliveryStates = new Map<string, DeliverySnapshot>();
const MAX_DELIVERY_STATES = 100;

function actionMetadataFromRaw(data: string): { id: string; type: string } | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; requestId?: unknown; id?: unknown; sessionId?: unknown };
    if (typeof parsed.type !== "string") return null;
    if (typeof parsed.requestId === "string" && parsed.requestId.length > 0) {
      return { id: parsed.requestId, type: parsed.type };
    }
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      return { id: parsed.id, type: parsed.type };
    }
    if (parsed.type === "switch_session" && typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
      return { id: `switch_session:${parsed.sessionId}`, type: parsed.type };
    }
    return null;
  } catch (err: unknown) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[useSocket] ignored queued delivery metadata parse failure:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

function setDeliveryState(
  metadata: { id: string; type: string } | null,
  state: DeliveryState,
  retryable = state === "failed",
) {
  if (!metadata) return;
  deliveryStates.set(metadata.id, {
    id: metadata.id,
    type: metadata.type,
    state,
    retryable,
    updatedAt: Date.now(),
  });
  while (deliveryStates.size > MAX_DELIVERY_STATES) {
    const oldest = deliveryStates.keys().next().value;
    if (!oldest) break;
    deliveryStates.delete(oldest);
  }
}

const messageQueue = new MessageQueue({
  maxSize: 50,
  ttlMs: 30_000,
  onDrop: (data) => {
    setDeliveryState(actionMetadataFromRaw(data), "failed", true);
  },
});

const heartbeat = createSocketHealth({
  pingIntervalMs: PING_INTERVAL,
  pongTimeoutMs: PONG_TIMEOUT,
  send: (data) => {
    if (globalSocket?.readyState === WebSocket.OPEN) {
      globalSocket.send(data);
    }
  },
  onDead: () => {
    globalSocket?.close();
  },
});

function notifyStateListeners() {
  for (const listener of stateListeners) listener();
}

function isConnectionUsable() {
  const health = useConnectionHealth.getState();
  return connectionState === "connected"
    || (health.state === "reconnecting" && health.hasConnected && !health.reconnectQuietElapsed);
}

function setConnectionState(state: typeof connectionState) {
  if (connectionState === state) return;
  connectionState = state;
  if (state === "reconnecting" && reconnectStartedAt === null) {
    reconnectStartedAt = Date.now();
  }
  if (state === "connected") {
    const reconnectDurationMs = reconnectStartedAt === null ? undefined : Date.now() - reconnectStartedAt;
    recordConnectionDiagnostic({
      event: "connected",
      layer: "unknown",
      state,
      attempt: reconnectAttempt,
      route: "/ws",
      visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
      reconnectDurationMs,
    });
    reconnectStartedAt = null;
  }
  setConnectionHealthState(state);
  notifyStateListeners();
}

function drainQueue() {
  if (globalSocket?.readyState !== WebSocket.OPEN) return;
  const messages = messageQueue.drain();
  for (const msg of messages) {
    globalSocket.send(msg);
    setDeliveryState(actionMetadataFromRaw(msg), "sent", false);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay(reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (globalSocket?.readyState === WebSocket.OPEN) return;
  if (globalSocket?.readyState === WebSocket.CONNECTING) return;

  if (connectionState !== "initializing" && connectionState !== "reconnecting") {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_STARTED, {
      attempt: reconnectAttempt,
      visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
    });
    setConnectionState("reconnecting");
  }
  void buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true })
    .catch((err: unknown) => {
      if (process.env.NODE_ENV !== "production") {
        console.debug(
          "[useSocket] websocket credential refresh unavailable; retrying:",
          err instanceof Error ? err.name : typeof err,
        );
      }
      recordConnectionDiagnostic({
        event: "credential_refresh_failed",
        layer: "credential",
        state: connectionState,
        attempt: reconnectAttempt,
        route: "/ws",
        visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
      });
      if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionState("disconnected");
        capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_EXHAUSTED, {
          attempts: reconnectAttempt,
          visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
        });
        return null;
      }
      scheduleReconnect();
      return null;
    })
    .then((wsUrl) => {
      if (!wsUrl) return;
      if (globalSocket?.readyState === WebSocket.OPEN || globalSocket?.readyState === WebSocket.CONNECTING) {
        return;
      }

      globalSocket = new WebSocket(wsUrl);

      globalSocket.onopen = () => {
        reconnectAttempt = 0;
        hasOpenedSocket = true;
        connectionEpoch++;
        setConnectionState("connected");
        capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_WS_CONNECTED);
        heartbeat.start();
        drainQueue();
      };

      globalSocket.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as ServerMessage;
          if (msg.type === "pong") {
            heartbeat.receivedPong();
            return;
          }
          if (msg.type === "client:ack") {
            setDeliveryState(
              { id: msg.actionId, type: msg.actionType },
              msg.status === "accepted" ? "accepted" : "failed",
              msg.retryable ?? msg.status !== "accepted",
            );
          }
          for (const handler of handlers) {
            handler(msg);
          }
        } catch (err: unknown) {
          if (process.env.NODE_ENV !== "production") {
            console.debug("[useSocket] ignored malformed websocket message:", err instanceof Error ? err.message : String(err));
          }
        }
      };

      globalSocket.onclose = (evt?: CloseEvent) => {
        heartbeat.stop();
        recordConnectionDiagnostic({
          event: "closed",
          layer: classifySocketClose(evt),
          state: connectionState,
          attempt: reconnectAttempt,
          route: "/ws",
          visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
          closeCode: evt?.code,
          wasClean: evt?.wasClean,
        });
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          setConnectionState("disconnected");
          capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_EXHAUSTED, {
            attempts: reconnectAttempt,
            visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
          });
          return;
        }
        if (hasOpenedSocket) {
          capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_STARTED, {
            attempt: reconnectAttempt,
            visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
          });
          setConnectionState("reconnecting");
        }
        scheduleReconnect();
      };

      globalSocket.onerror = () => {
        globalSocket?.close();
      };
    });
}

export function ensureConnected() {
  if (!globalSocket || globalSocket.readyState === WebSocket.CLOSED) {
    connect();
  }
}

type ClientMessage = {
  type: "message";
  text: string;
  displayText?: string;
  sessionId?: string;
  requestId?: string;
} | {
  type: "switch_session";
  sessionId: string;
} | {
  type: "approval_response";
  id: string;
  approved: boolean;
} | {
  type: "abort";
  requestId: string;
} | {
  type: string;
  text?: string;
  displayText?: string;
  sessionId?: string;
  requestId?: string;
  id?: string;
  approved?: boolean;
};

export function sendMessage(msg: ClientMessage) {
  const data = JSON.stringify(msg);
  const metadata = actionMetadataFromRaw(data);
  if (globalSocket?.readyState === WebSocket.OPEN) {
    globalSocket.send(data);
    setDeliveryState(metadata, "sent", false);
  } else if (msg.type === "abort") {
    // Don't queue aborts -- if the socket dropped, the run on the gateway
    // is already cleaned up server-side via the WS close handler.
    setDeliveryState(metadata, "failed", true);
    return;
  } else {
    messageQueue.enqueue(data, metadata?.id);
    setDeliveryState(metadata, "queued", true);
  }
}

export function manualReconnect() {
  reconnectAttempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connectionState === "initializing") {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_STARTED, {
      attempt: reconnectAttempt,
      visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
    });
    setConnectionState("reconnecting");
  }
  connect();
}

export function getConnectionState() {
  return connectionState;
}

export function getConnectionEpoch() {
  return connectionEpoch;
}

export function subscribeConnectionState(listener: () => void): () => void {
  stateListeners.add(listener);
  if (!healthUnsubscribe) {
    healthUnsubscribe = useConnectionHealth.subscribe(() => {
      notifyStateListeners();
    });
  }
  return () => {
    stateListeners.delete(listener);
    if (stateListeners.size === 0 && healthUnsubscribe) {
      healthUnsubscribe();
      healthUnsubscribe = null;
    }
  };
}

export function getGlobalSocket() {
  return globalSocket;
}

export function getDeliveryState(id: string): DeliverySnapshot | null {
  return deliveryStates.get(id) ?? null;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && globalSocket?.readyState === WebSocket.OPEN) {
      heartbeat.pingNow();
    } else if (document.visibilityState === "visible" && connectionState !== "connected") {
      reconnectAttempt = 0;
      connect();
    }
  });
}

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const [epoch, setEpoch] = useState(connectionEpoch);
  const handlerRef = useRef<MessageHandler | null>(null);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const subscribe = useCallback((handler: MessageHandler) => {
    handlers.add(handler);
    handlerRef.current = handler;
    return () => {
      handlers.delete(handler);
      handlerRef.current = null;
    };
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const send = useCallback((msg: ClientMessage) => {
    sendMessage(msg);
  }, []);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only-live-ref: the cleanup reads handlerRef.current at teardown time to delete whatever handler is registered then (the subscribe callback updates the ref over the component's life). Snapshotting it at effect-setup would delete a stale/null handler and leak the live one; an empty dep array is required so the shared socket subscription wires up exactly once.
  useEffect(() => {
    ensureConnected();

    const unsubState = subscribeConnectionState(() => {
      setConnected(isConnectionUsable());
      setEpoch(connectionEpoch);
    });
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- cannot be a lazy useState initializer: connectionState is a mutable module-level store shared across all useSocket consumers, so reading it during render would be impure; syncing here after subscribe is what closes the gap between initial render and subscription
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- external-store sync: re-reads the module-level connectionState immediately after subscribing to catch any transition that landed between the initial render and this effect running, preventing a missed-update race
    setConnected(isConnectionUsable());
    setEpoch(connectionEpoch);

    return () => {
      unsubState();
      if (handlerRef.current) {
        handlers.delete(handlerRef.current);
      }
    };
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional run-once mount effect: it wires up the shared socket and a connection-state subscription. Its only references (ensureConnected, subscribeConnectionState, the module-level connectionState store, the stable setConnected setter, and handlerRef) are non-reactive, so an empty dep array is correct and re-running would re-subscribe needlessly
  }, []);

  return { connected, connectionEpoch: epoch, subscribe, send };
}
