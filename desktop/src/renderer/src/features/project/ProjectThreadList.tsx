import { AlertCircle, MessageSquare, Plus } from "lucide-react";
import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
  RuntimeSummary,
  TaskAgentSummary,
} from "@matrix-os/contracts";
import type { ProjectWorkspaceStatus } from "../../stores/project-workspaces";
import { groupProjectWorkspaceThreads } from "../coding-agents/project-workspace-model";

export interface ProjectThreadListModel {
  projectThreads: AgentThreadSummary[];
  taskGroups: Array<{ task: TaskAgentSummary; threads: AgentThreadSummary[] }>;
  otherThreads: AgentThreadSummary[];
  truncated: boolean;
}

function statusLabel(thread: AgentThreadSummary): string {
  switch (thread.attention) {
    case "approval_required":
      return "Approval";
    case "input_required":
      return "Input";
    case "failed":
      return "Failed";
    case "completed":
      return "Done";
    default:
      return thread.status === "running" ? "Working" : thread.status.replaceAll("_", " ");
  }
}

/**
 * Builds the Chats list model for one project: the workspace pages grouped per
 * task, overlaid with the live runtime-summary projections (attention/active
 * threads are newer than the bounded workspace pages). Summary threads missing
 * from the workspace are appended so actionable chats never disappear; without
 * a workspace (capability off or load failed) the summary projection alone
 * backs the list.
 */
export function buildProjectThreadListModel(
  workspace: ProjectAgentWorkspace | null,
  summary: RuntimeSummary,
  projectId: string,
): ProjectThreadListModel {
  const grouped = workspace ? groupProjectWorkspaceThreads(workspace) : null;
  const projectThreads = grouped ? [...grouped.projectThreads] : [];
  const taskGroups = workspace
    ? workspace.tasks.items.map((task) => ({
        task,
        threads: [...(grouped?.taskThreads[task.id] ?? [])],
      }))
    : [];
  const otherThreads = grouped ? [...grouped.unlistedTaskThreads] : [];

  const overlay = new Map<string, AgentThreadSummary>();
  for (const thread of summary.activeThreads.items) {
    if (thread.projectId === projectId) overlay.set(thread.id, thread);
  }
  // Attention entries win the dedupe: they carry the actionable state.
  for (const thread of summary.attentionThreads.items) {
    if (thread.projectId === projectId) overlay.set(thread.id, thread);
  }

  const applyOverlay = (threads: AgentThreadSummary[]): AgentThreadSummary[] =>
    threads.map((thread) => {
      const live = overlay.get(thread.id);
      if (live) overlay.delete(thread.id);
      return live ?? thread;
    });

  const mergedProject = applyOverlay(projectThreads);
  const mergedGroups = taskGroups.map((group) => ({ ...group, threads: applyOverlay(group.threads) }));
  const mergedOther = applyOverlay(otherThreads);

  for (const thread of overlay.values()) {
    const group = thread.taskId ? mergedGroups.find((candidate) => candidate.task.id === thread.taskId) : undefined;
    if (group) group.threads.push(thread);
    else if (thread.taskId) mergedOther.push(thread);
    else mergedProject.push(thread);
  }

  return {
    projectThreads: mergedProject,
    taskGroups: mergedGroups,
    otherThreads: mergedOther,
    truncated: Boolean(
      workspace && (workspace.tasks.hasMore || workspace.projectThreads.hasMore || workspace.taskThreads.hasMore),
    ),
  };
}

function ThreadRow({
  thread,
  providerLabel,
  selected,
  onSelect,
}: {
  thread: AgentThreadSummary;
  providerLabel: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Chat ${thread.title}`}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className="group relative flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-6 pr-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        background: selected ? "var(--accent-muted)" : "transparent",
        color: selected ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      <span
        aria-hidden="true"
        className="absolute bottom-1.5 left-2 top-1.5 w-0.5 rounded-full"
        style={{ background: selected ? "var(--accent)" : "var(--border-subtle)" }}
      />
      <MessageSquare size={13} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{thread.title}</span>
        <span className="flex items-center gap-1 truncate text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          <span className="truncate">{providerLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="capitalize">{statusLabel(thread)}</span>
        </span>
      </span>
    </button>
  );
}

export function ProjectThreadList({
  projectId,
  projectLabel,
  summary,
  workspace,
  status,
  error,
  selectedThreadId,
  canCreate,
  onSelectThread,
  onNewChat,
  onRetry,
}: {
  projectId: string;
  projectLabel: string;
  summary: RuntimeSummary;
  workspace: ProjectAgentWorkspace | null;
  status: ProjectWorkspaceStatus | "absent";
  error: string | null;
  selectedThreadId: string | null;
  canCreate: boolean;
  onSelectThread: (threadId: string) => void;
  onNewChat: (taskId?: string) => void;
  onRetry: () => void;
}) {
  const model = buildProjectThreadListModel(workspace, summary, projectId);
  const providerLabel = (thread: AgentThreadSummary) =>
    summary.providers.find((provider) => provider.id === thread.providerId)?.displayName ?? "Agent";
  const isEmpty = model.projectThreads.length === 0
    && model.taskGroups.every((group) => group.threads.length === 0)
    && model.otherThreads.length === 0;

  return (
    <nav
      aria-label="Project conversations"
      className="flex min-h-0 w-[clamp(220px,24vw,288px)] shrink-0 flex-col border-r"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-secondary)" }}
    >
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
          Chats
        </span>
        <button
          type="button"
          aria-label={`New chat in ${projectLabel}`}
          title={`New chat in ${projectLabel}`}
          disabled={!canCreate}
          onClick={() => onNewChat()}
          className="rounded p-1 outline-none hover:bg-[var(--bg-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
          style={{ color: "var(--text-tertiary)" }}
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {status === "loading" && !workspace ? (
          <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
            Loading conversations…
          </p>
        ) : null}
        {status === "error" && !workspace ? (
          <div className="flex items-start gap-2 px-2 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            <AlertCircle size={13} className="mt-0.5 shrink-0" style={{ color: "var(--warning)" }} />
            <span className="min-w-0 flex-1">{error ?? "Project workspace unavailable"}</span>
            <button
              type="button"
              aria-label="Retry loading the project workspace"
              className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium"
              style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
              onClick={onRetry}
            >
              Retry
            </button>
          </div>
        ) : null}

        <div role="group" aria-label="Project chats" className="space-y-0.5">
          {model.projectThreads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              providerLabel={providerLabel(thread)}
              selected={thread.id === selectedThreadId}
              onSelect={() => onSelectThread(thread.id)}
            />
          ))}
        </div>

        <div className="mt-2 space-y-1">
          {model.taskGroups.map((group) => (
            <div key={group.task.id} role="group" aria-label={`Task ${group.task.title}`}>
              <div className="flex items-center gap-1 rounded-md">
                <span
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-[11px] font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {group.task.title}
                </span>
                <button
                  type="button"
                  aria-label={`New chat for ${group.task.title}`}
                  disabled={!canCreate}
                  onClick={() => onNewChat(group.task.id)}
                  className="mr-1 rounded p-1 outline-none hover:bg-[var(--accent-muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  <Plus size={11} />
                </button>
              </div>
              <div className="space-y-0.5">
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    providerLabel={providerLabel(thread)}
                    selected={thread.id === selectedThreadId}
                    onSelect={() => onSelectThread(thread.id)}
                  />
                ))}
              </div>
            </div>
          ))}
          {model.otherThreads.length > 0 ? (
            <div role="group" aria-label="Other task conversations">
              <div
                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                Other task conversations
              </div>
              <div className="space-y-0.5">
                {model.otherThreads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    providerLabel={providerLabel(thread)}
                    selected={thread.id === selectedThreadId}
                    onSelect={() => onSelectThread(thread.id)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {isEmpty && status !== "loading" ? (
          <p className="px-2 py-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            No chats yet. Start one with the + button above.
          </p>
        ) : null}
        {model.truncated ? (
          <p className="px-2 pt-2 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            Showing the current conversation window
          </p>
        ) : null}
      </div>
    </nav>
  );
}
