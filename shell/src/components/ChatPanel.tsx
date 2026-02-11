"use client";

import { useState, useEffect, useCallback } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { reduceChat, type ChatMessage } from "@/lib/chat";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Tool } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  WrenchIcon,
  CheckCircleIcon,
  LoaderCircleIcon,
  SendIcon,
} from "lucide-react";

function ToolMessage({ msg }: { msg: ChatMessage }) {
  const isRunning = msg.content.startsWith("Using ");

  return (
    <Tool>
      <div className="flex w-full items-center gap-2 p-3">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{msg.tool}</span>
        {isRunning ? (
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <CheckCircleIcon className="size-4 text-green-600" />
        )}
      </div>
    </Tool>
  );
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { connected, subscribe, send } = useSocket();

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
    <aside className="flex w-[400px] flex-col border-l border-border bg-card">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium">Chat</span>
        <Badge variant={connected ? "default" : "destructive"} className="text-xs">
          <span className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-current"}`} />
          {connected ? "Connected" : "Offline"}
        </Badge>
      </header>
      <Separator />

      <Conversation>
        <ConversationContent className="gap-4 px-4 py-3">
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === "user" ? (
                <Message from="user">
                  <MessageContent>{msg.content}</MessageContent>
                </Message>
              ) : msg.tool ? (
                <ToolMessage msg={msg} />
              ) : msg.role === "system" ? (
                <div className="text-xs px-3 py-1 rounded bg-background text-muted-foreground">
                  {msg.content}
                </div>
              ) : (
                <Message from="assistant">
                  <MessageContent>
                    <MessageResponse>{msg.content}</MessageResponse>
                  </MessageContent>
                </Message>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-xs px-3 py-1 text-muted-foreground">
              <LoaderCircleIcon className="size-3 animate-spin" />
              Thinking...
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <Separator />
      <form onSubmit={handleSubmit} className="flex gap-2 px-4 py-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={connected ? "Ask Matrix OS..." : "Connecting..."}
          disabled={!connected}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!connected || busy || !input.trim()}
        >
          <SendIcon />
        </Button>
      </form>
    </aside>
  );
}
