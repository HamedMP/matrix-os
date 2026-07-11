import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
  RuntimeSummary,
  TaskAgentSummary,
} from "@matrix-os/contracts";
import { AlertTriangle, CircleDot, MessageSquare } from "lucide-react";
import type { CodingAgentWorkspaceViewMode } from "../../../../shared/coding-agent-project-workspace";
import {
  BOARD_COLUMNS,
  type CardStatus,
} from "../../stores/board";
import { groupProjectWorkspaceThreads } from "./project-workspace-model";

const COLUMN_LABEL: Record<(typeof BOARD_COLUMNS)[number], string> = {
  todo: "Todo",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  complete: "Complete",
  archived: "Archived",
};

const COLUMN_COLOR: Record<(typeof BOARD_COLUMNS)[number], string> = {
  todo: "var(--status-todo)",
  running: "var(--status-running)",
  waiting: "var(--status-waiting)",
  blocked: "var(--status-blocked)",
  complete: "var(--status-complete)",
  archived: "var(--status-todo)",
};

function aggregateLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function providerLabel(
  providers: RuntimeSummary["providers"],
  thread: AgentThreadSummary,
): string {
  return providers.find((provider) => provider.id === thread.providerId)?.displayName
    ?? "Agent";
}

function statusLabel(thread: AgentThreadSummary): string {
  if (thread.attention === "approval_required") return "Approval";
  if (thread.attention === "input_required") return "Input";
  if (thread.attention === "failed") return "Failed";
  if (thread.status === "running") return "Working";
  return thread.status.replaceAll("_", " ");
}

function ChatRow({
  thread,
  providers,
  selected,
  onOpen,
}: {
  thread: AgentThreadSummary;
  providers: RuntimeSummary["providers"];
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Open chat ${thread.title}`}
      aria-current={selected ? "page" : undefined}
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        background: selected ? "var(--accent-muted)" : "transparent",
        color: selected ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      <MessageSquare size={12} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium">{thread.title}</span>
        <span className="block truncate text-[10px] capitalize" style={{ color: "var(--text-tertiary)" }}>
          {providerLabel(providers, thread)} · {statusLabel(thread)}
        </span>
      </span>
    </button>
  );
}

function TaskCard({
  task,
  threads,
  providers,
  selectedTaskId,
  selectedThreadId,
  canMoveTasks,
  movingTaskId,
  onSelectTask,
  onOpenThread,
  onMoveTask,
}: {
  task: TaskAgentSummary;
  threads: AgentThreadSummary[];
  providers: RuntimeSummary["providers"];
  selectedTaskId: string | null;
  selectedThreadId: string | null;
  canMoveTasks: boolean;
  movingTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onOpenThread: (threadId: string) => void;
  onMoveTask: (taskId: string, status: CardStatus, order: number) => void;
}) {
  const moving = movingTaskId === task.id;
  return (
    <article
      className="rounded-xl border p-2.5 shadow-sm"
      style={{
        borderColor: selectedTaskId === task.id ? "var(--accent)" : "var(--border-subtle)",
        background: "var(--bg-surface)",
      }}
    >
      <button
        type="button"
        onClick={() => onSelectTask(task.id)}
        className="block w-full rounded-md px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="block truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {task.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          <span>{aggregateLabel(task.threadCount, "chat", "chats")}</span>
          <span aria-hidden="true">·</span>
          <span>{aggregateLabel(task.activeThreadCount, "active", "active")}</span>
          {task.attentionCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1" style={{ color: "var(--warning)" }}>
                <AlertTriangle size={10} aria-hidden="true" />
                {aggregateLabel(task.attentionCount, "needs attention", "need attention")}
              </span>
            </>
          ) : null}
        </span>
      </button>

      {threads.length > 0 ? (
        <div className="mt-2 space-y-0.5 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
          {threads.map((thread) => (
            <ChatRow
              key={thread.id}
              thread={thread}
              providers={providers}
              selected={thread.id === selectedThreadId}
              onOpen={() => onOpenThread(thread.id)}
            />
          ))}
        </div>
      ) : (
        <p className="mt-2 border-t px-2 pt-2 text-[11px]" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
          No chats yet
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
        <span className="inline-flex items-center gap-1 text-[10px] capitalize" style={{ color: "var(--text-tertiary)" }}>
          <CircleDot size={10} aria-hidden="true" /> {task.priority}
        </span>
        <select
          aria-label={`Move ${task.title}`}
          value={task.status}
          disabled={!canMoveTasks || moving}
          onChange={(event) => {
            const status = event.currentTarget.value as CardStatus;
            if (status !== task.status) onMoveTask(task.id, status, task.order);
          }}
          className="no-drag h-7 rounded-md border bg-transparent px-2 text-[11px] capitalize outline-none disabled:opacity-50"
          style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
        >
          {BOARD_COLUMNS.map((status) => (
            <option key={status} value={status}>{COLUMN_LABEL[status]}</option>
          ))}
        </select>
      </div>
    </article>
  );
}

export function AgentKanbanBoard({
  workspace,
  providers,
  selectedTaskId,
  selectedThreadId,
  canMoveTasks,
  movingTaskId,
  mutationError,
  onSelectTask,
  onOpenThread,
  onMoveTask,
}: {
  workspace: ProjectAgentWorkspace;
  providers: RuntimeSummary["providers"];
  selectedTaskId: string | null;
  selectedThreadId: string | null;
  canMoveTasks: boolean;
  movingTaskId: string | null;
  mutationError: string | null;
  onSelectTask: (taskId: string) => void;
  onOpenThread: (threadId: string) => void;
  onMoveTask: (taskId: string, status: CardStatus, order: number) => void;
}) {
  const groupedThreads = groupProjectWorkspaceThreads(workspace);
  const visibleTasks = workspace.tasks.items.filter((task) => task.status !== "archived");
  return (
    <section aria-label={`${workspace.project.label} Kanban`} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {mutationError ? (
        <p className="border-b px-4 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
          {mutationError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-4">
        {BOARD_COLUMNS.map((status) => {
          const tasks = visibleTasks
            .filter((task) => task.status === status)
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
          return (
            <div key={status} className="flex w-[280px] shrink-0 flex-col">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className="h-2 w-2 rounded-full" style={{ background: COLUMN_COLOR[status] }} aria-hidden="true" />
                <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{COLUMN_LABEL[status]}</h2>
                <span className="text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>{tasks.length}</span>
              </div>
              <div className="space-y-2 rounded-xl bg-[var(--bg-secondary)] p-1.5">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    threads={groupedThreads.taskThreads[task.id] ?? []}
                    providers={providers}
                    selectedTaskId={selectedTaskId}
                    selectedThreadId={selectedThreadId}
                    canMoveTasks={canMoveTasks}
                    movingTaskId={movingTaskId}
                    onSelectTask={onSelectTask}
                    onOpenThread={onOpenThread}
                    onMoveTask={onMoveTask}
                  />
                ))}
                {tasks.length === 0 ? (
                  <p className="px-3 py-8 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>No tasks</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AgentWorkspaceViewSwitch({
  viewMode,
  onChange,
}: {
  viewMode: CodingAgentWorkspaceViewMode;
  onChange: (viewMode: CodingAgentWorkspaceViewMode) => void;
}) {
  return (
    <div role="group" aria-label="Workspace view" className="inline-flex rounded-lg border p-0.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      {(["conversation", "kanban"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-label={mode === "conversation" ? "Conversation" : "Kanban"}
          aria-pressed={viewMode === mode}
          onClick={() => onChange(mode)}
          className="rounded-md px-3 py-1.5 text-xs font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{
            background: viewMode === mode ? "var(--bg-selected)" : "transparent",
            color: viewMode === mode ? "var(--text-primary)" : "var(--text-tertiary)",
          }}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
