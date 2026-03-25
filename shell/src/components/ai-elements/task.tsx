"use client";

// Inspired by AI Elements task pattern, consistent with MissionControl TaskCard
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  CircleIcon,
  LoaderCircleIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react";

export type TaskStatus = "pending" | "in-progress" | "completed" | "error";

export interface TaskData {
  title: string;
  description?: string;
  status: TaskStatus;
}

const statusConfig: Record<
  TaskStatus,
  { icon: LucideIcon; className: string; label: string }
> = {
  pending: {
    icon: CircleIcon,
    className: "text-muted-foreground",
    label: "Pending",
  },
  "in-progress": {
    icon: LoaderCircleIcon,
    className: "text-primary animate-spin",
    label: "In progress",
  },
  completed: {
    icon: CheckCircle2Icon,
    className: "text-green-600",
    label: "Completed",
  },
  error: {
    icon: XCircleIcon,
    className: "text-destructive",
    label: "Error",
  },
};

export type TaskProps = HTMLAttributes<HTMLDivElement> & {
  task: TaskData;
};

export function Task({ task, className, ...props }: TaskProps) {
  const config = statusConfig[task.status];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border bg-card/50 p-2.5",
        className,
      )}
      {...props}
    >
      <Icon
        className={cn("size-4 shrink-0 mt-0.5", config.className)}
        aria-label={config.label}
      />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "text-xs font-medium",
            task.status === "completed" && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </span>
        {task.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {task.description}
          </p>
        )}
      </div>
    </div>
  );
}

export type TaskListProps = HTMLAttributes<HTMLDivElement> & {
  tasks: TaskData[];
};

export function TaskList({ tasks, className, ...props }: TaskListProps) {
  if (tasks.length === 0) return null;

  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      {tasks.map((task, i) => (
        <Task key={`${task.title}-${i}`} task={task} />
      ))}
    </div>
  );
}

export function parseTask(content: string): TaskData | null {
  const match = content.match(
    /```task\n([\s\S]*?)```/,
  );
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.title === "string" &&
      typeof parsed.status === "string"
    ) {
      return parsed as TaskData;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}
