"use client";

import { Badge } from "@/components/ui/badge";
import type { TaskItem } from "@/hooks/useTaskBoard";

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Queued", variant: "outline" },
  in_progress: { label: "Building...", variant: "default" },
  completed: { label: "Done", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
};

function timeAgo(dateStr?: string): string | null {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

interface TaskCardProps {
  task: TaskItem;
  onClick?: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const config = statusConfig[task.status] ?? statusConfig.pending;
  const timestamp = task.completedAt ?? task.claimedAt ?? task.createdAt;

  return (
    <button
      onClick={onClick}
      className="rounded border border-border bg-card/50 p-2 text-xs text-left w-full hover:bg-accent/50 transition-colors"
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-medium">{task.appName ?? task.id}</span>
        <Badge variant={config.variant} className="text-[10px] px-1.5 py-0 shrink-0">
          {config.label}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-1 mt-1">
        {task.assignedTo && (
          <span className="text-muted-foreground text-[10px] truncate">
            {task.assignedTo}
          </span>
        )}
        {!task.assignedTo && task.type === "provision" && (
          <span className="text-muted-foreground text-[10px]">builder</span>
        )}
        {timestamp && (
          <span className="text-muted-foreground text-[10px] ml-auto">
            {timeAgo(timestamp)}
          </span>
        )}
      </div>
    </button>
  );
}
