import { AlertCircle, ArrowUp, Bot, Code2, MessageSquare, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { openProjectChat } from "../../lib/project-chat";
import { useConnection } from "../../stores/connection";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { capabilityEnabled } from "../coding-agents/capabilities";
import {
  buildProjectThreadListModel,
  formatRelativeTime,
  threadRailStatus,
  type ThreadRailTone,
} from "./ProjectThreadList";

const STATUS_COLORS: Record<ThreadRailTone, { background: string; color: string }> = {
  running: { background: "var(--accent-muted)", color: "var(--status-running)" },
  waiting: { background: "var(--warning-muted)", color: "var(--warning)" },
  done: { background: "var(--success-muted)", color: "var(--success)" },
  failed: { background: "var(--danger-muted)", color: "var(--danger)" },
};

function allThreads(summary: RuntimeSummary, projectId: string, workspace: ProjectAgentWorkspace | null): AgentThreadSummary[] {
  const model = buildProjectThreadListModel(workspace ?? null, summary, projectId);
  const deduped = new Map<string, AgentThreadSummary>();
  for (const thread of [
    ...model.projectThreads,
    ...model.taskGroups.flatMap((group) => group.threads),
    ...model.otherThreads,
  ]) {
    deduped.set(thread.id, thread);
  }
  return [...deduped.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export default function ProjectOverview({
  projectId,
  projectLabel,
  summary,
  active,
}: {
  projectId: string;
  projectLabel: string;
  summary: RuntimeSummary | null;
  active: boolean;
}) {
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const workspaceEntry = useProjectWorkspaces((state) => state.entries[projectId]);
  const ensureWorkspace = useProjectWorkspaces((state) => state.ensure);
  const refreshWorkspace = useProjectWorkspaces((state) => state.refresh);
  const workspaceEnabled = summary ? capabilityEnabled(summary, "codingAgentsProjectWorkspace") : false;
  const canCreate = summary ? capabilityEnabled(summary, "codingAgentsThreadCreate") : false;
  const threads = useMemo(
    () => summary ? allThreads(summary, projectId, workspaceEntry?.workspace ?? null) : [],
    [projectId, summary, workspaceEntry?.workspace],
  );
  const taskTitleById = useMemo(
    () => new Map(workspaceEntry?.workspace?.tasks.items.map((task) => [task.id, task.title]) ?? []),
    [workspaceEntry?.workspace],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !workspaceEnabled) return;
    useProjectWorkspaces.getState().ensureRuntimeScope(runtimeScope);
    void ensureWorkspace(projectId);
  }, [active, ensureWorkspace, projectId, runtimeScope, workspaceEnabled]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const project = summary?.projects.items.find((candidate) => candidate.id === projectId);
  const threadCount = workspaceEntry?.workspace?.project.threadCount ?? project?.threadCount ?? threads.length;
  const taskCount = workspaceEntry?.workspace?.project.taskCount ?? project?.taskCount ?? 0;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto" style={{ background: "var(--bg-app)" }}>
      <div className="mx-auto flex w-full max-w-[860px] flex-col px-8 pb-12 pt-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]" style={{ color: "var(--text-primary)" }}>
            {projectLabel}
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--text-tertiary)" }}>
            {threadCount} {threadCount === 1 ? "conversation" : "conversations"}
            <span aria-hidden="true"> · </span>
            {taskCount} {taskCount === 1 ? "task" : "tasks"}
          </p>
        </div>

        <button
          type="button"
          aria-label={`Start a new chat in ${projectLabel}`}
          disabled={!canCreate}
          onClick={() => void openProjectChat(projectId, { compose: true })}
          className="group mb-10 flex min-h-[128px] w-full flex-col justify-between rounded-2xl border p-4 text-left outline-none transition-[border-color,box-shadow,transform] hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            borderColor: "var(--border-default)",
            background: "var(--bg-surface)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          <span className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            How can I help you today?
          </span>
          <span className="flex w-full items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md border" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
              <Plus size={14} />
            </span>
            <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
              <Bot size={14} />
              {summary?.providers[0]?.displayName ?? "Agent"}
            </span>
            <span className="flex-1" />
            <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}>
              <ArrowUp size={15} />
            </span>
          </span>
        </button>

        <section aria-labelledby={`project-${projectId}-recent-sessions`}>
          <div className="mb-2 flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--border-subtle)" }}>
            <h2 id={`project-${projectId}-recent-sessions`} className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Recent sessions
            </h2>
            <span className="text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>{threads.length}</span>
          </div>

          {workspaceEntry?.status === "loading" && threads.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>Loading recent sessions…</p>
          ) : null}
          {workspaceEntry?.status === "error" && threads.length === 0 ? (
            <div className="flex items-center gap-3 py-6 text-sm" style={{ color: "var(--text-secondary)" }}>
              <AlertCircle size={15} style={{ color: "var(--warning)" }} />
              <span>{workspaceEntry.error ?? "Project sessions are unavailable."}</span>
              <button
                type="button"
                onClick={() => void refreshWorkspace(projectId)}
                className="rounded-md border px-2 py-1 text-xs font-medium"
                style={{ borderColor: "var(--border-default)" }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {summary && workspaceEntry?.status !== "loading" && workspaceEntry?.status !== "error" && threads.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: "var(--text-tertiary)" }}>No sessions yet. Start one above.</p>
          ) : null}

          <div>
            {threads.map((thread) => {
              const status = threadRailStatus(thread);
              const provider = summary?.providers.find((candidate) => candidate.id === thread.providerId)?.displayName ?? "Agent";
              const taskTitle = thread.taskId ? taskTitleById.get(thread.taskId) : undefined;
              const relative = formatRelativeTime(thread.updatedAt, nowMs);
              return (
                <button
                  key={thread.id}
                  type="button"
                  aria-label={`Open session ${thread.title}`}
                  onClick={() => void openProjectChat(projectId, { threadId: thread.id })}
                  className="group flex w-full items-center gap-3 border-b px-2 py-3 text-left outline-none transition-colors last:border-b-0 hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--bg-raised)", color: "var(--text-secondary)" }}>
                    {thread.taskId ? <Code2 size={15} /> : <MessageSquare size={15} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{thread.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                      <span>{provider}</span>
                      {taskTitle ? <><span aria-hidden="true">·</span><span className="truncate">{taskTitle}</span></> : null}
                    </span>
                  </span>
                  {status ? (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={STATUS_COLORS[status.tone]}>{status.label}</span>
                  ) : null}
                  {relative ? <span className="w-16 shrink-0 text-right text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>{relative}</span> : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
