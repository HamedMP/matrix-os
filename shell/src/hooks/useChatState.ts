"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { useConversation } from "@/hooks/useConversation";
import { reduceChat, hydrateMessages, type ChatMessage } from "@/lib/chat";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();
const GATEWAY_FETCH_TIMEOUT_MS = 10_000;

interface QueuedMessage {
  text: string;
  requestId: string;
}

export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  /** Name of the currently-running tool, or null when the agent is just
      generating text. Drives the global AgentStatusCard's stage label. */
  currentTool: string | null;
  connected: boolean;
  queue: QueuedMessage[];
  conversations: ReturnType<typeof useConversation>["conversations"];
  submitMessage: (text: string) => void;
  newChat: () => Promise<void>;
  switchConversation: (id: string) => void;
  /** Stops the in-flight agent run. No-op if nothing is running. */
  abortCurrent: () => void;
}

export function useChatState(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const { connected, subscribe, send } = useSocket();
  const { conversations, load } = useConversation();
  const sessionRef = useRef(sessionId);
  const pendingRestoreSessionRef = useRef<string | null>(null);
  // Tracks the requestId of the in-flight run so abortCurrent() can target
  // the right server-side AbortController. Cleared on terminal events.
  const currentRequestIdRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
    if (conversations.length === 0) return;
    let aborted = false;

    const sorted = [...conversations].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const latest = sorted[0];

    if (!sessionId && latest.messageCount > 0) {
      load(latest.id)
        .then((conv) => {
          if (!aborted && conv) {
            pendingRestoreSessionRef.current = conv.id;
            setSessionId(conv.id);
            setMessages(hydrateMessages(conv.messages));
          }
        })
        .catch((err) => {
          if (!aborted) {
            console.warn(`[chat] Failed to restore conversation "${latest.id}":`, err);
          }
        });
    }

    return () => {
      aborted = true;
    };
  }, [conversations, sessionId, load]);

  useEffect(() => {
    if (!sessionId || pendingRestoreSessionRef.current !== sessionId) {
      return;
    }

    pendingRestoreSessionRef.current = null;
    send({ type: "switch_session", sessionId });
  }, [sessionId, send]);

  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === "kernel:init") {
        setSessionId(msg.sessionId);
        setBusy(true);
        return;
      }

      if (msg.type === "kernel:tool_start") {
        setCurrentTool(msg.tool);
        setMessages((prev) => reduceChat(prev, msg));
        return;
      }

      if (msg.type === "kernel:tool_end") {
        setCurrentTool(null);
        setMessages((prev) => reduceChat(prev, msg));
        return;
      }

      if (
        msg.type === "kernel:result" ||
        msg.type === "kernel:error" ||
        msg.type === "kernel:aborted"
      ) {
        setBusy(false);
        setCurrentTool(null);
        currentRequestIdRef.current = null;

        // Abort clears the queue: stopping means "I changed my mind".
        // Result/error drain the next queued message as before.
        if (msg.type === "kernel:aborted") {
          setQueue([]);
        } else {
          setQueue((prev) => {
            if (prev.length === 0) return prev;
            const [next, ...rest] = prev;
            send({
              type: "message",
              text: next.text,
              sessionId: sessionRef.current,
              requestId: next.requestId,
            });
            currentRequestIdRef.current = next.requestId;
            setBusy(true);
            return rest;
          });
        }

        if (msg.type === "kernel:error" || msg.type === "kernel:aborted") {
          setMessages((prev) => reduceChat(prev, msg));
        }
        return;
      }

      setMessages((prev) => reduceChat(prev, msg));
    });
  }, [subscribe, send]);

  const submitMessage = useCallback(
    (text: string) => {
      if (!text) return;

      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
          timestamp: Date.now(),
          requestId,
        },
      ]);

      if (busy) {
        setQueue((prev) => [...prev, { text, requestId }]);
      } else {
        send({ type: "message", text, sessionId, requestId });
        currentRequestIdRef.current = requestId;
        setBusy(true);
      }
    },
    [busy, send, sessionId],
  );

  const abortCurrent = useCallback(() => {
    const requestId = currentRequestIdRef.current;
    if (!requestId) return;
    send({ type: "abort", requestId });
    // Don't optimistically clear busy here -- wait for kernel:aborted from
    // the server so the message log stays consistent with the real run
    // state. The server-side abort takes ~50ms; visible stop button can
    // show a "stopping..." pending state in the meantime if needed.
  }, [send]);

  const newChat = useCallback(async () => {
    setMessages([]);
    setQueue([]);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const { id } = await res.json();
        setSessionId(id);
        send({ type: "switch_session", sessionId: id });
      } else {
        setSessionId(undefined);
      }
    } catch (err) {
      console.warn("[chat] Failed to create conversation:", err);
      setSessionId(undefined);
    }
  }, [send]);

  const switchConversation = useCallback(
    (id: string) => {
      load(id)
        .then((conv) => {
          if (conv) {
            setSessionId(conv.id);
            setMessages(hydrateMessages(conv.messages));
            setQueue([]);
            send({ type: "switch_session", sessionId: conv.id });
          }
        })
        .catch((err) => {
          console.warn(`[chat] Failed to switch to conversation "${id}":`, err);
        });
    },
    [load, send],
  );

  return {
    messages,
    sessionId,
    busy,
    currentTool,
    connected,
    queue,
    conversations,
    submitMessage,
    newChat,
    switchConversation,
    abortCurrent,
  };
}
