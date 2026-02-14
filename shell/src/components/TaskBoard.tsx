"use client";

import { useTaskBoard, type TaskItem } from "@/hooks/useTaskBoard";
import { TaskCard } from "./TaskCard";
import { Badge } from "@/components/ui/badge";
import { Loader2Icon, CircleDotIcon, PlayIcon, CheckCircle2Icon } from "lucide-react";

function TaskColumn({
  title,
  icon,
  tasks,
}: {
  title: string;
  icon: React.ReactNode;
  tasks: TaskItem[];
}) {
  return (
    <div className="flex flex-1 flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        {icon}
        <span>{title}</span>
        {tasks.length > 0 && (
          <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-auto">
            {tasks.length}
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto px-0.5">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

export function TaskBoard() {
  const { todo, inProgress, done, provision } = useTaskBoard();

  return (
    <div className="flex h-full flex-col">
      {provision.active && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          <span>Building {provision.total} apps...</span>
        </div>
      )}
      {!provision.active && provision.total > 0 && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <CheckCircle2Icon className="size-3" />
          <span>
            {provision.succeeded}/{provision.total} apps built
            {provision.failed > 0 && ` (${provision.failed} failed)`}
          </span>
        </div>
      )}
      <div className="flex flex-1 gap-3 overflow-hidden p-2">
        <TaskColumn
          title="To Do"
          icon={<CircleDotIcon className="size-3" />}
          tasks={todo}
        />
        <TaskColumn
          title="In Progress"
          icon={<PlayIcon className="size-3" />}
          tasks={inProgress}
        />
        <TaskColumn
          title="Done"
          icon={<CheckCircle2Icon className="size-3" />}
          tasks={done}
        />
      </div>
    </div>
  );
}
