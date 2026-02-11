"use client";

import { useState, useEffect, useCallback } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { useConversation } from "@/hooks/useConversation";
import { reduceChat, hydrateMessages, type ChatMessage } from "@/lib/chat";

export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  conversations: ReturnType<typeof useConversation>["conversations"];
  submitMessage: (text: string) => void;
  newChat: () => void;
  switchConversation: (id: string) => void;
}

export function useChatState(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { connected, subscribe, send } = useSocket();
  const { conversations, load } = useConversation();

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

      if (msg.type === "kernel:result") {
        setBusy(false);
        return;
      }

      if (msg.type === "kernel:error") {
        setBusy(false);
      }

      setMessages((prev) => reduceChat(prev, msg));
    });
  }, [subscribe]);

  const submitMessage = useCallback(
    (text: string) => {
      if (!text || busy) return;

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
          timestamp: Date.now(),
        },
      ]);

      send({ type: "message", text, sessionId });
      setBusy(true);
    },
    [busy, send, sessionId],
  );

  const newChat = useCallback(() => {
    setMessages([]);
    setSessionId(undefined);
  }, []);

  const switchConversation = useCallback(
    (id: string) => {
      load(id).then((conv) => {
        if (conv) {
          setSessionId(conv.id);
          setMessages(hydrateMessages(conv.messages));
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
    conversations,
    submitMessage,
    newChat,
    switchConversation,
  };
}
