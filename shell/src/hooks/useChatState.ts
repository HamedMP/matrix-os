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
  displayText?: string;
  requestId: string;
}

const MAX_SEEN_REPLAY_EVENTS = 2_000;

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
  submitMessage: (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    options?: { displayText?: string; promptText?: string },
  ) => void;
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
  const { connected, connectionEpoch, subscribe, send } = useSocket();
  const { conversations, load } = useConversation();
  const sessionRef = useRef(sessionId);
  const lastReattachKeyRef = useRef<string | null>(null);
  const seenReplayEventIdsRef = useRef<Set<string>>(new Set());
  // Tracks the requestId of the in-flight run so abortCurrent() can target
  // the right server-side AbortController. Cleared on terminal events.
  const currentRequestIdRef = useRef<string | null>(null);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of sessionId, read synchronously inside the async WS message handler (which is registered once via a stable subscribe and must not re-subscribe on every sessionId change); writing it in render keeps the mirror current for those deferred reads
  sessionRef.current = sessionId;

  useEffect(() => {
    if (conversations.length === 0) return;
    let aborted = false;

    const sorted = conversations.toSorted(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const latest = sorted[0];

    if (!sessionId && latest.messageCount > 0) {
      load(latest.id)
        .then((conv) => {
          if (!aborted && conv) {
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
    if (!connected || !sessionId) return;
    const key = `${sessionId}:${connectionEpoch}`;
    if (lastReattachKeyRef.current === key) return;
    lastReattachKeyRef.current = key;
    send({ type: "switch_session", sessionId });
  }, [connected, connectionEpoch, sessionId, send]);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- the multiple setState calls (setBusy/setCurrentTool/setQueue/setSessionId/setMessages) all fire from inside the async WebSocket message handler in response to discrete server events (a run's init -> tool -> result/error/aborted transition), never synchronously during render, so they are event-driven transitions and not a render-time cascade
  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      const eventId = "eventId" in msg && typeof msg.eventId === "string" ? msg.eventId : null;
      if (eventId) {
        const seen = seenReplayEventIdsRef.current;
        if (seen.has(eventId)) return;
        seen.add(eventId);
        while (seen.size > MAX_SEEN_REPLAY_EVENTS) {
          const oldest = seen.values().next().value;
          if (!oldest) break;
          seen.delete(oldest);
        }
      }

      if (msg.type === "kernel:init") {
        setSessionId(msg.sessionId);
        if (msg.requestId) {
          currentRequestIdRef.current = msg.requestId;
        }
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
              displayText: next.displayText,
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

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const submitMessage = useCallback(
    (
      text: string,
      _files?: Array<{ name: string; type: string; data: string }>,
      options?: { displayText?: string; promptText?: string },
    ) => {
      if (!text) return;

      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outboundText = options?.promptText?.trim() || text;
      const displayText = options?.displayText?.trim() || text;

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: displayText,
          timestamp: Date.now(),
          requestId,
        },
      ]);

      if (busy) {
        setQueue((prev) => [...prev, { text: outboundText, displayText, requestId }]);
      } else {
        send({ type: "message", text: outboundText, displayText, sessionId, requestId });
        currentRequestIdRef.current = requestId;
        setBusy(true);
      }
    },
    [busy, send, sessionId],
  );

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const abortCurrent = useCallback(() => {
    const requestId = currentRequestIdRef.current;
    if (!requestId) return;
    send({ type: "abort", requestId });
    // Don't optimistically clear busy here -- wait for kernel:aborted from
    // the server so the message log stays consistent with the real run
    // state. The server-side abort takes ~50ms; visible stop button can
    // show a "stopping..." pending state in the meantime if needed.
  }, [send]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
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
      } else {
        setSessionId(undefined);
      }
    } catch (err) {
      console.warn("[chat] Failed to create conversation:", err);
      setSessionId(undefined);
    }
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const switchConversation = useCallback(
    (id: string) => {
      load(id)
        .then((conv) => {
          if (conv) {
            setSessionId(conv.id);
            setMessages(hydrateMessages(conv.messages));
            setQueue([]);
          }
        })
        .catch((err) => {
          console.warn(`[chat] Failed to switch to conversation "${id}":`, err);
        });
    },
    [load],
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
