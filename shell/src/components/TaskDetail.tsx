"use client";

import type { TaskItem } from "@/hooks/useTaskBoard";
import { Badge } from "@/components/ui/badge";
import { XIcon } from "lucide-react";

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Queued", variant: "outline" },
  in_progress: { label: "In Progress", variant: "default" },
  completed: { label: "Completed", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
};

function formatTimestamp(dateStr?: string): string | null {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleString();
}

function tryParseJson(str: string): string {
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return str;
  }
}

interface TaskDetailProps {
  task: TaskItem;
  onClose: () => void;
}

export function TaskDetail({ task, onClose }: TaskDetailProps) {
  const config = statusConfig[task.status] ?? statusConfig.pending;

  return (
    <div className="flex flex-col h-full w-[340px] border-l border-border bg-card animate-in slide-in-from-right-4">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-medium truncate">Task Detail</span>
        <button
          onClick={onClose}
          className="size-6 flex items-center justify-center rounded hover:bg-muted transition-colors"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{task.appName ?? task.id}</h3>
          <Badge variant={config.variant} className="mt-1 text-xs">
            {config.label}
          </Badge>
        </div>

        {task.assignedTo && (
          <div>
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Agent</span>
            <p className="text-sm mt-0.5">{task.assignedTo}</p>
          </div>
        )}

        <div>
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Type</span>
          <p className="text-sm mt-0.5">{task.type}</p>
        </div>

        {task.createdAt && (
          <div>
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Created</span>
            <p className="text-sm mt-0.5">{formatTimestamp(task.createdAt)}</p>
          </div>
        )}

        {task.claimedAt && (
          <div>
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Started</span>
            <p className="text-sm mt-0.5">{formatTimestamp(task.claimedAt)}</p>
          </div>
        )}

        {task.completedAt && (
          <div>
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Finished</span>
            <p className="text-sm mt-0.5">{formatTimestamp(task.completedAt)}</p>
          </div>
        )}

        <div>
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Input</span>
          <pre className="text-xs mt-1 p-2 rounded bg-muted/50 overflow-x-auto whitespace-pre-wrap break-all">
            {tryParseJson(task.input)}
          </pre>
        </div>

        {task.output && (
          <div>
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Output</span>
            <pre className="text-xs mt-1 p-2 rounded bg-muted/50 overflow-x-auto whitespace-pre-wrap break-all">
              {tryParseJson(task.output)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
