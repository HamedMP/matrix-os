"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useSocket } from "@/hooks/useSocket";
import { Button } from "@/components/ui/button";
import { SparklesIcon, SendIcon } from "lucide-react";

interface AIButtonProps {
  appName: string;
  appPath: string;
  sessionId?: string;
}

export function AIButton({ appName, appPath, sessionId }: AIButtonProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { send } = useSocket();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = useCallback(() => {
    if (!input.trim()) return;
    send({
      type: "message",
      text: `[customize_app: ${appName}] ${input.trim()}`,
      sessionId,
    });
    setInput("");
    setOpen(false);
  }, [input, appName, sessionId, send]);

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-5 rounded-sm"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Customize with AI"
      >
        <SparklesIcon className="size-3" />
      </Button>
    );
  }

  return (
    <div
      className="flex items-center gap-1 absolute right-2 top-1/2 -translate-y-1/2 z-10"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={`Change ${appName}...`}
        className="h-6 w-44 rounded border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-5 rounded-sm"
        onClick={submit}
        disabled={!input.trim()}
      >
        <SendIcon className="size-3" />
      </Button>
    </div>
  );
}
