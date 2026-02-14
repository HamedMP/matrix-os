"use client";

import { Badge } from "@/components/ui/badge";
import type { TaskItem } from "@/hooks/useTaskBoard";

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Queued", variant: "outline" },
  in_progress: { label: "Building...", variant: "default" },
  completed: { label: "Done", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
};

export function TaskCard({ task }: { task: TaskItem }) {
  const config = statusConfig[task.status] ?? statusConfig.pending;

  return (
    <div className="rounded border border-border bg-card/50 p-2 text-xs">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-medium">{task.appName ?? task.id}</span>
        <Badge variant={config.variant} className="text-[10px] px-1.5 py-0">
          {config.label}
        </Badge>
      </div>
      {task.type === "provision" && (
        <div className="mt-1 text-muted-foreground text-[10px]">builder</div>
      )}
    </div>
  );
}
