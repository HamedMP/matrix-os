"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string }
  | { type: "kernel:text"; text: string }
  | { type: "kernel:tool_start"; tool: string }
  | { type: "kernel:tool_end" }
  | { type: "kernel:result"; data: Record<string, unknown> }
  | { type: "kernel:error"; message: string }
  | { type: "file:change"; path: string; event: "add" | "change" | "unlink" }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number };

type MessageHandler = (msg: ServerMessage) => void;

function getGatewayWs(): string {
  if (process.env.NEXT_PUBLIC_GATEWAY_WS) return process.env.NEXT_PUBLIC_GATEWAY_WS;
  if (typeof window === "undefined") return "ws://localhost:4000/ws";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:4000/ws`;
}
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

  const send = useCallback((msg: { type: string; text?: string; sessionId?: string }) => {
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
