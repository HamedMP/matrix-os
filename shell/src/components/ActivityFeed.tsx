"use client";

import { useState, useEffect, useRef } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";

interface Activity {
  id: string;
  text: string;
  timestamp: number;
}

export function ActivityFeed() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const { subscribe } = useSocket();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      let text: string | null = null;

      if (msg.type === "kernel:tool_start") {
        text = `Tool: ${msg.tool}`;
      } else if (msg.type === "file:change") {
        text = `File ${msg.event}: ${msg.path}`;
      } else if (msg.type === "kernel:result") {
        text = "Kernel completed";
      } else if (msg.type === "kernel:error") {
        text = `Error: ${msg.message}`;
      }

      if (text) {
        setActivities((prev) => [
          ...prev.slice(-99),
          { id: `act-${Date.now()}`, text, timestamp: Date.now() },
        ]);
      }
    });
  }, [subscribe]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ left: scrollRef.current.scrollWidth });
  }, [activities]);

  return (
    <div
      className="border-t"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface)",
        height: collapsed ? 32 : 120,
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1 cursor-pointer select-none"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="text-xs font-medium" style={{ color: "var(--color-muted)" }}>
          Activity {collapsed ? "+" : "-"}
        </span>
        <span className="text-xs" style={{ color: "var(--color-muted)" }}>
          {activities.length} events
        </span>
      </div>

      {!collapsed && (
        <div ref={scrollRef} className="overflow-y-auto px-3 pb-2" style={{ maxHeight: 88 }}>
          {activities.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--color-muted)" }}>
              No activity yet
            </p>
          ) : (
            activities.map((act) => (
              <div key={act.id} className="flex gap-2 text-xs py-0.5">
                <span style={{ color: "var(--color-muted)" }}>
                  {new Date(act.timestamp).toLocaleTimeString()}
                </span>
                <span>{act.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
