"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getGatewayWs } from "@/lib/gateway";

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
  | { type: "data:change"; app: string; key: string };

type MessageHandler = (msg: ServerMessage) => void;

const GATEWAY_WS = getGatewayWs();

let globalSocket: WebSocket | null = null;
let handlers = new Set<MessageHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect() {
  if (globalSocket?.readyState === WebSocket.OPEN) return;
  if (globalSocket?.readyState === WebSocket.CONNECTING) return;

  globalSocket = new WebSocket(GATEWAY_WS);

  globalSocket.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data) as ServerMessage;
      for (const handler of handlers) {
        handler(msg);
      }
    } catch {
      // ignore malformed messages
    }
  };

  globalSocket.onclose = () => {
    reconnectTimer = setTimeout(connect, 2000);
  };

  globalSocket.onerror = () => {
    globalSocket?.close();
  };
}

function ensureConnected() {
  if (!globalSocket || globalSocket.readyState === WebSocket.CLOSED) {
    connect();
  }
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
    if (globalSocket?.readyState === WebSocket.OPEN) {
      globalSocket.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    ensureConnected();

    const checkConnection = () => {
      setConnected(globalSocket?.readyState === WebSocket.OPEN);
    };

    const interval = setInterval(checkConnection, 1000);
    checkConnection();

    return () => {
      clearInterval(interval);
      if (handlerRef.current) {
        handlers.delete(handlerRef.current);
      }
    };
  }, []);

  return { connected, subscribe, send };
}
