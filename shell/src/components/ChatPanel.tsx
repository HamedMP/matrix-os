"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { reduceChat, type ChatMessage } from "@/lib/chat";

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { connected, subscribe, send } = useSocket();
  const scrollRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
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
      setInput("");
      setBusy(true);
    },
    [input, busy, send, sessionId],
  );

  return (
    <aside
      className="flex w-[400px] flex-col border-l"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface)",
      }}
    >
      <header
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="text-sm font-medium">Chat</span>
        <span
          className="h-2 w-2 rounded-full"
          style={{
            background: connected
              ? "var(--color-success)"
              : "var(--color-error)",
          }}
        />
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === "user" ? (
              <div
                className="ml-8 rounded-lg px-3 py-2 text-sm"
                style={{ background: "var(--color-accent)", color: "#fff" }}
              >
                {msg.content}
              </div>
            ) : msg.role === "system" ? (
              <div
                className="text-xs px-3 py-1 rounded"
                style={{
                  color: "var(--color-muted)",
                  background: "var(--color-bg)",
                }}
              >
                {msg.content}
              </div>
            ) : (
              <div
                className="mr-8 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
                style={{ background: "var(--color-bg)" }}
              >
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div
            className="text-xs px-3 py-1"
            style={{ color: "var(--color-muted)" }}
          >
            Thinking...
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex gap-2 border-t px-4 py-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={connected ? "Ask Matrix OS..." : "Connecting..."}
          disabled={!connected}
          className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "var(--color-fg)",
          }}
        />
        <button
          type="submit"
          disabled={!connected || busy || !input.trim()}
          className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "#fff" }}
        >
          Send
        </button>
      </form>
    </aside>
  );
}
