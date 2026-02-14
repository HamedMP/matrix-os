"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { useCronJobs } from "@/hooks/useCronJobs";
import { usePreferences } from "@/stores/preferences";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { AppTile } from "./AppTile";
import { CronCard } from "./CronCard";
import {
  XIcon,
  Loader2Icon,
  CheckCircle2Icon,
  LayoutGridIcon,
  ListTodoIcon,
  KanbanSquareIcon,
  ClockIcon,
  PlusIcon,
} from "lucide-react";

interface AppEntry {
  name: string;
  path: string;
}

interface MissionControlProps {
  apps: AppEntry[];
  openWindows: Set<string>;
  onOpenApp: (name: string, path: string) => void;
  onClose: () => void;
}

export function MissionControl({
  apps,
  openWindows,
  onOpenApp,
  onClose,
}: MissionControlProps) {
  const { tasks, provision, todo, inProgress, done, selectedTaskId, selectTask, addTask } =
    useTaskBoard();
  const { jobs } = useCronJobs();
  const { taskView, setTaskView } = usePreferences();
  const [newTaskText, setNewTaskText] = useState("");

  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedTaskId) {
          selectTask(null);
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, selectedTaskId, selectTask]);

  function handleAddTask(e: FormEvent) {
    e.preventDefault();
    const text = newTaskText.trim();
    if (!text) return;
    addTask(text);
    setNewTaskText("");
  }

  return (
    <div className="fixed inset-0 z-[45]">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-lg"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      <div className="relative flex flex-col h-full z-10 overflow-hidden md:pl-14">
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-lg font-semibold">Mission Control</h2>
          <button
            onClick={onClose}
            className="size-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {provision.active && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-1.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            <span>Building {provision.total} apps...</span>
          </div>
        )}
        {!provision.active && provision.total > 0 && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-1.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3" />
            <span>
              {provision.succeeded}/{provision.total} apps built
              {provision.failed > 0 && ` (${provision.failed} failed)`}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {apps.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <LayoutGridIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  Apps
                </h3>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1">
                {apps.map((app) => (
                  <AppTile
                    key={app.path}
                    name={app.name}
                    isOpen={openWindows.has(app.path)}
                    onClick={() => {
                      onOpenApp(app.name, app.path);
                      onClose();
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {jobs.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <ClockIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  Scheduled
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {jobs.map((job) => (
                  <CronCard key={job.id} job={job} />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="flex items-center gap-2 mb-3">
              <ListTodoIcon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Tasks
              </h3>
              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => setTaskView("grid")}
                  className={`size-6 flex items-center justify-center rounded transition-colors ${
                    taskView === "grid"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Grid view"
                >
                  <LayoutGridIcon className="size-3.5" />
                </button>
                <button
                  onClick={() => setTaskView("kanban")}
                  className={`size-6 flex items-center justify-center rounded transition-colors ${
                    taskView === "kanban"
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Kanban view"
                >
                  <KanbanSquareIcon className="size-3.5" />
                </button>
              </div>
            </div>

            <form onSubmit={handleAddTask} className="flex gap-2 mb-3">
              <input
                type="text"
                value={newTaskText}
                onChange={(e) => setNewTaskText(e.target.value)}
                placeholder="Add a task..."
                className="flex-1 rounded border border-border bg-card/50 px-2.5 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={!newTaskText.trim()}
                className="size-7 flex items-center justify-center rounded border border-border bg-card/50 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </form>

            {tasks.length > 0 && taskView === "grid" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onClick={() => selectTask(task.id)}
                  />
                ))}
              </div>
            )}

            {tasks.length > 0 && taskView === "kanban" && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    To Do ({todo.length})
                  </h4>
                  <div className="flex flex-col gap-1.5">
                    {todo.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => selectTask(task.id)}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    In Progress ({inProgress.length})
                  </h4>
                  <div className="flex flex-col gap-1.5">
                    {inProgress.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => selectTask(task.id)}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Done ({done.length})
                  </h4>
                  <div className="flex flex-col gap-1.5">
                    {done.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => selectTask(task.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <ListTodoIcon className="size-6 mb-2 opacity-40" />
                <p className="text-xs">No tasks yet. Add one above or ask in the chat.</p>
              </div>
            )}
          </section>
        </div>
      </div>

      {selectedTask && (
        <div
          className="fixed inset-0 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) selectTask(null);
          }}
        >
          <div className="absolute right-0 top-0 h-full">
            <TaskDetail
              task={selectedTask}
              onClose={() => selectTask(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
