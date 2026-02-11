"use client";

import { useState, useEffect } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import { WrenchIcon, LoaderCircleIcon, CheckCircleIcon } from "lucide-react";

interface ThoughtState {
  tool: string;
  status: "running" | "done";
}

export function ThoughtCard() {
  const [thought, setThought] = useState<ThoughtState | null>(null);
  const [visible, setVisible] = useState(false);
  const { subscribe } = useSocket();

  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === "kernel:tool_start") {
        setThought({ tool: msg.tool, status: "running" });
        setVisible(true);
      } else if (msg.type === "kernel:tool_end") {
        setThought((prev) => (prev ? { ...prev, status: "done" } : null));
        setTimeout(() => setVisible(false), 1500);
      } else if (msg.type === "kernel:result" || msg.type === "kernel:error") {
        setTimeout(() => setVisible(false), 500);
      }
    });
  }, [subscribe]);

  if (!visible || !thought) return null;

  return (
    <div className="pointer-events-none animate-in fade-in slide-in-from-top-2 rounded-lg border border-border bg-card/90 px-3 py-2 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{thought.tool}</span>
        {thought.status === "running" ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <CheckCircleIcon className="size-3.5 text-green-600" />
        )}
      </div>
    </div>
  );
}
