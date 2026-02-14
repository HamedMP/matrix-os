"use client";

import { useState, useEffect, useRef } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronsUpDownIcon, ActivityIcon } from "lucide-react";

interface Activity {
  id: string;
  text: string;
  timestamp: number;
}

export function ActivityFeed() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [open, setOpen] = useState(true);
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
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border bg-card">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-1.5 select-none hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Activity</span>
          <ChevronsUpDownIcon className="size-3 text-muted-foreground" />
        </div>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          {activities.length}
        </Badge>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div ref={scrollRef} className="overflow-y-auto px-3 pb-2 max-h-22">
          {activities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-4 text-muted-foreground">
              <ActivityIcon className="size-5 mb-1.5 opacity-40" />
              <p className="text-xs font-medium">No recent activity</p>
              <p className="text-[10px] opacity-70">System events will appear here as the OS works.</p>
            </div>
          ) : (
            activities.map((act) => (
              <div key={act.id} className="flex gap-2 text-xs py-0.5">
                <span className="text-muted-foreground shrink-0">
                  {new Date(act.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-foreground">{act.text}</span>
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
