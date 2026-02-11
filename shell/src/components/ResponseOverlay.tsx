"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/chat";
import {
  MessageResponse,
} from "@/components/ai-elements/message";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ResponseOverlayProps {
  messages: ChatMessage[];
  busy: boolean;
  onDismiss: () => void;
}

export function ResponseOverlay({
  messages,
  busy,
  onDismiss,
}: ResponseOverlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.tool);

  const show = busy || lastAssistant;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastAssistant?.content]);

  if (!show) return null;

  return (
    <div className="w-full max-w-[560px] animate-in fade-in slide-in-from-bottom-2 rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
        <div className="flex items-center gap-1.5">
          {busy && (
            <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />
          )}
          <span className="text-[11px] text-muted-foreground">
            {busy ? "Responding..." : "Response"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={onDismiss}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="max-h-[200px] overflow-y-auto px-3 py-2 text-sm"
      >
        {lastAssistant ? (
          <MessageResponse>{lastAssistant.content}</MessageResponse>
        ) : busy ? (
          <span className="text-xs text-muted-foreground">Thinking...</span>
        ) : null}
      </div>
    </div>
  );
}
