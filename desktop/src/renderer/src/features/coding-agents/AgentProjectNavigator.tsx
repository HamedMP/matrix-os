import {
  AlertCircle,
  FolderKanban,
  MessageSquare,
  Plus,
} from "lucide-react";
import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
  RuntimeSummary,
} from "@matrix-os/contracts";
import { groupProjectWorkspaceThreads } from "./project-workspace-model";

type ProjectWorkspaceStatus = "idle" | "loading" | "ready" | "error";

export interface AgentProjectNavigatorProps {
  summary: RuntimeSummary;
  workspace: ProjectAgentWorkspace | null;
  liveThread?: AgentThreadSummary | null;
  status: ProjectWorkspaceStatus;
  error?: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  selectedThreadId: string | null;
  canCreate?: boolean;
  onSelectProject: (projectId: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectThread: (threadId: string) => void;
  onNewChat: (projectId: string, taskId?: string) => void;
}

function CountBadge({ children }: { children: number }) {
  return (
    <span
      className="min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-medium tabular-nums"
      style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }}
    >
      {children}
    </span>
  );
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

export function AgentProjectNavigator({
  summary,
  workspace,
  liveThread,
  status,
  error,
  selectedProjectId,
  selectedTaskId,
  selectedThreadId,
  canCreate = true,
  onSelectProject,
  onSelectTask,
  onSelectThread,
  onNewChat,
}: AgentProjectNavigatorProps) {
  const grouped = workspace ? groupProjectWorkspaceThreads(workspace) : null;
  const projectedThreads = new Map(
    [...summary.activeThreads.items, ...summary.attentionThreads.items]
      .map((thread) => [thread.id, thread] as const),
  );
  if (liveThread) projectedThreads.set(liveThread.id, liveThread);
  const displayThread = (thread: AgentThreadSummary) =>
    projectedThreads.get(thread.id) ?? thread;
  const providerLabel = (thread: AgentThreadSummary) =>
    summary.providers.find((provider) => provider.id === thread.providerId)?.displayName
      ?? "Agent";

  return (
    <nav
      aria-label="Projects and conversations"
      className="flex min-h-0 w-[clamp(220px,24vw,288px)] shrink-0 flex-col border-r"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-secondary)" }}
    >
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
          Projects
        </span>
        <CountBadge>{summary.projects.items.length}</CountBadge>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="space-y-1">
          {summary.projects.items.map((project) => {
            const selected = project.id === selectedProjectId;
            return (
              <div key={project.id}>
                <button
                  type="button"
                  aria-label={`Project ${project.label}`}
                  aria-expanded={selected}
                  onClick={() => onSelectProject(project.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{
                    background: selected ? "var(--bg-tertiary)" : "transparent",
                    color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                >
                  <FolderKanban size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">{project.label}</span>
                  {project.attentionCount > 0 ? (
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--warning)" }} title={`${project.attentionCount} need attention`} />
                  ) : null}
                  <CountBadge>{project.threadCount}</CountBadge>
                </button>

                {selected ? (
                  <div className="pb-2 pl-2 pt-1">
                    {status === "loading" && !workspace ? (
                      <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
                        Loading conversations…
                      </p>
                    ) : null}
                    {status === "error" && !workspace ? (
                      <div className="flex items-start gap-2 px-2 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                        <AlertCircle size={13} className="mt-0.5 shrink-0" style={{ color: "var(--warning)" }} />
                        <span>{error ?? "Project workspace unavailable"}</span>
                      </div>
                    ) : null}
                    {workspace && grouped ? (
                      <>
                        <div role="group" aria-label="Project chats" className="space-y-0.5">
                          <div className="flex items-center justify-between px-2 py-1">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--text-tertiary)" }}>
                              Project chats
                            </span>
                            <button
                              type="button"
                              aria-label={`New chat in ${workspace.project.label}`}
                              disabled={!canCreate}
                              onClick={() => onNewChat(workspace.project.id)}
                              className="rounded p-1 outline-none hover:bg-[var(--bg-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                              style={{ color: "var(--text-tertiary)" }}
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                          {grouped.projectThreads.length > 0 ? grouped.projectThreads.map((thread) => (
                            <ThreadRow
                              key={thread.id}
                              thread={displayThread(thread)}
                              providerLabel={providerLabel(displayThread(thread))}
                              selected={thread.id === selectedThreadId}
                              onSelect={() => onSelectThread(thread.id)}
                            />
                          )) : (
                            <p className="px-6 py-1 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                              No project chats
                            </p>
                          )}
                        </div>

                        <div className="mt-2 space-y-1">
                          {workspace.tasks.items.map((task) => {
                            const taskThreads = grouped.taskThreads[task.id] ?? [];
                            return (
                              <div key={task.id} role="group" aria-label={`Task ${task.title}`}>
                                <div
                                  className="flex items-center gap-1 rounded-md"
                                  style={{ background: task.id === selectedTaskId ? "var(--bg-tertiary)" : "transparent" }}
                                >
                                  <button
                                    type="button"
                                    onClick={() => onSelectTask(task.id)}
                                    className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                                    style={{ color: "var(--text-secondary)" }}
                                  >
                                    {task.title}
                                  </button>
                                  <CountBadge>{task.threadCount}</CountBadge>
                                  <button
                                    type="button"
                                    aria-label={`New chat for ${task.title}`}
                                    disabled={!canCreate}
                                    onClick={() => onNewChat(workspace.project.id, task.id)}
                                    className="mr-1 rounded p-1 outline-none hover:bg-[var(--accent-muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                                    style={{ color: "var(--text-tertiary)" }}
                                  >
                                    <Plus size={11} />
                                  </button>
                                </div>
                                <div className="space-y-0.5">
                                  {taskThreads.map((thread) => (
                                    <ThreadRow
                                      key={thread.id}
                                      thread={displayThread(thread)}
                                      providerLabel={providerLabel(displayThread(thread))}
                                      selected={thread.id === selectedThreadId}
                                      onSelect={() => onSelectThread(thread.id)}
                                    />
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                          {grouped.unlistedTaskThreads.length > 0 ? (
                            <div role="group" aria-label="Other task conversations">
                              <div
                                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em]"
                                style={{ color: "var(--text-tertiary)" }}
                              >
                                Other task conversations
                              </div>
                              <div className="space-y-0.5">
                                {grouped.unlistedTaskThreads.map((thread) => (
                                  <ThreadRow
                                    key={thread.id}
                                    thread={displayThread(thread)}
                                    providerLabel={providerLabel(displayThread(thread))}
                                    selected={thread.id === selectedThreadId}
                                    onSelect={() => onSelectThread(thread.id)}
                                  />
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                        {workspace.tasks.hasMore
                          || workspace.projectThreads.hasMore
                          || workspace.taskThreads.hasMore ? (
                          <p className="px-2 pt-2 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                            Showing the current conversation window
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {summary.projects.hasMore ? (
            <p className="px-2 py-1 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              Showing the current project window
            </p>
          ) : null}
        </div>

        {summary.projects.items.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <FolderKanban size={20} className="mx-auto mb-2" style={{ color: "var(--text-tertiary)" }} />
            <p className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>No projects yet</p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              Create a project to start a coding conversation.
            </p>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
