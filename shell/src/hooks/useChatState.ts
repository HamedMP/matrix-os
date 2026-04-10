"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { useConversation } from "@/hooks/useConversation";
import { reduceChat, hydrateMessages, type ChatMessage } from "@/lib/chat";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface QueuedMessage {
  text: string;
  requestId: string;
}

export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  queue: QueuedMessage[];
  conversations: ReturnType<typeof useConversation>["conversations"];
  submitMessage: (text: string) => void;
  newChat: () => Promise<void>;
  switchConversation: (id: string) => void;
}

export function useChatState(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const { connected, subscribe, send } = useSocket();
  const { conversations, load } = useConversation();
  const sessionRef = useRef(sessionId);
  const pendingRestoreSessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  useEffect(() => {
    if (conversations.length === 0) return;

    const sorted = [...conversations].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const latest = sorted[0];

    if (!sessionId && latest.messageCount > 0) {
      load(latest.id).then((conv) => {
        if (conv) {
          pendingRestoreSessionRef.current = conv.id;
          setSessionId(conv.id);
          setMessages(hydrateMessages(conv.messages));
        }
      });
    }
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

      if (msg.type === "kernel:result" || msg.type === "kernel:error") {
        setBusy(false);

        setQueue((prev) => {
          if (prev.length === 0) return prev;
          const [next, ...rest] = prev;
          send({
            type: "message",
            text: next.text,
            sessionId: sessionRef.current,
            requestId: next.requestId,
          });
          setBusy(true);
          return rest;
        });

        if (msg.type === "kernel:error") {
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
        setBusy(true);
      }
    },
    [busy, send, sessionId],
  );

  const newChat = useCallback(async () => {
    setMessages([]);
    setQueue([]);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const { id } = await res.json();
        setSessionId(id);
        send({ type: "switch_session", sessionId: id });
      } else {
        setSessionId(undefined);
      }
    } catch {
      setSessionId(undefined);
    }
  }, [send]);

  const switchConversation = useCallback(
    (id: string) => {
      load(id).then((conv) => {
        if (conv) {
          setSessionId(conv.id);
          setMessages(hydrateMessages(conv.messages));
          setQueue([]);
          send({ type: "switch_session", sessionId: conv.id });
        }
      });
    },
    [load, send],
  );

  return {
    messages,
    sessionId,
    busy,
    connected,
    queue,
    conversations,
    submitMessage,
    newChat,
    switchConversation,
  };
}
