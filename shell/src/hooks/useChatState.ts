"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { useConversation } from "@/hooks/useConversation";
import { reduceChat, hydrateMessages, type ChatMessage } from "@/lib/chat";

export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  queue: string[];
  conversations: ReturnType<typeof useConversation>["conversations"];
  submitMessage: (text: string) => void;
  newChat: () => void;
  switchConversation: (id: string) => void;
}

export function useChatState(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const { connected, subscribe, send } = useSocket();
  const { conversations, load } = useConversation();
  const sessionRef = useRef(sessionId);
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
          setSessionId(conv.id);
          setMessages(hydrateMessages(conv.messages));
        }
      });
    }
  }, [conversations, sessionId, load]);

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
          send({ type: "message", text: next, sessionId: sessionRef.current });
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

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
          timestamp: Date.now(),
        },
      ]);

      if (busy) {
        setQueue((prev) => [...prev, text]);
      } else {
        send({ type: "message", text, sessionId });
        setBusy(true);
      }
    },
    [busy, send, sessionId],
  );

  const newChat = useCallback(() => {
    setMessages([]);
    setSessionId(undefined);
    setQueue([]);
  }, []);

  const switchConversation = useCallback(
    (id: string) => {
      load(id).then((conv) => {
        if (conv) {
          setSessionId(conv.id);
          setMessages(hydrateMessages(conv.messages));
          setQueue([]);
        }
      });
    },
    [load],
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
