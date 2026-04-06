"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getGatewayWs } from "@/lib/gateway";
import { createSocketHealth, MessageQueue, reconnectDelay } from "@/lib/socket-health";
import { useConnectionHealth } from "./useConnectionHealth";

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: Record<string, unknown>; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "file:change"; path: string; event: "add" | "change" | "unlink" }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number }
  | { type: "data:change"; app: string; key: string }
  | { type: "pong" };

type MessageHandler = (msg: ServerMessage) => void;

const GATEWAY_WS = getGatewayWs();
const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const MAX_RECONNECT_ATTEMPTS = 60;

let globalSocket: WebSocket | null = null;
let handlers = new Set<MessageHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let connectionState: "connected" | "reconnecting" | "disconnected" = "disconnected";
let stateListeners = new Set<() => void>();

const messageQueue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

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

function setConnectionState(state: typeof connectionState) {
  if (connectionState === state) return;
  connectionState = state;
  useConnectionHealth.setState({ state });
  for (const listener of stateListeners) listener();
}

function drainQueue() {
  if (globalSocket?.readyState !== WebSocket.OPEN) return;
  const messages = messageQueue.drain();
  for (const msg of messages) {
    globalSocket.send(msg);
  }
}

function connect() {
  if (globalSocket?.readyState === WebSocket.OPEN) return;
  if (globalSocket?.readyState === WebSocket.CONNECTING) return;

  setConnectionState("reconnecting");
  globalSocket = new WebSocket(GATEWAY_WS);

  globalSocket.onopen = () => {
    reconnectAttempt = 0;
    setConnectionState("connected");
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
      for (const handler of handlers) {
        handler(msg);
      }
    } catch {
      // ignore malformed messages
    }
  };

  globalSocket.onclose = () => {
    heartbeat.stop();
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      setConnectionState("disconnected");
      return;
    }
    setConnectionState("reconnecting");
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  globalSocket.onerror = () => {
    globalSocket?.close();
  };
}

export function ensureConnected() {
  if (!globalSocket || globalSocket.readyState === WebSocket.CLOSED) {
    connect();
  }
}

export function sendMessage(msg: { type: string; text?: string; sessionId?: string; requestId?: string }) {
  const data = JSON.stringify(msg);
  if (globalSocket?.readyState === WebSocket.OPEN) {
    globalSocket.send(data);
  } else {
    messageQueue.enqueue(data);
  }
}

export function manualReconnect() {
  reconnectAttempt = 0;
  connect();
}

export function getConnectionState() {
  return connectionState;
}

export function subscribeConnectionState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function getGlobalSocket() {
  return globalSocket;
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
  const handlerRef = useRef<MessageHandler | null>(null);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlers.add(handler);
    handlerRef.current = handler;
    return () => {
      handlers.delete(handler);
      handlerRef.current = null;
    };
  }, []);

  const send = useCallback((msg: { type: string; text?: string; sessionId?: string; requestId?: string }) => {
    sendMessage(msg);
  }, []);

  useEffect(() => {
    ensureConnected();

    const unsubState = subscribeConnectionState(() => {
      setConnected(connectionState === "connected");
    });
    setConnected(connectionState === "connected");

    return () => {
      unsubState();
      if (handlerRef.current) {
        handlers.delete(handlerRef.current);
      }
    };
  }, []);

  return { connected, subscribe, send };
}
