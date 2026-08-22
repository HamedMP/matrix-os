import { AlertCircle, MessageSquare, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import type { ProjectWorkspaceStatus } from "../../stores/project-workspaces";
import {
  buildProjectThreadListModel,
  canLoadMoreProjectThreads,
  filterProjectThreadListModel,
  formatRelativeTime,
  threadRailStatus,
  type ThreadRailFilter,
  type ThreadRailTone,
} from "./project-thread-list-model";

export {
  buildProjectThreadListModel,
  canLoadMoreProjectThreads,
  filterProjectThreadListModel,
  formatRelativeTime,
  threadRailStatus,
} from "./project-thread-list-model";

const RAIL_TONE_STYLES: Record<ThreadRailTone, { background: string; color: string }> = {
  running: { background: "var(--accent-muted)", color: "var(--status-running)" },
  waiting: { background: "var(--warning-muted)", color: "var(--warning)" },
  done: { background: "var(--success-muted)", color: "var(--success)" },
  failed: { background: "var(--danger-muted)", color: "var(--danger)" },
};

function ThreadRow({
  thread,
  providerLabel,
  selected,
  nowMs,
  onSelect,
}: {
  thread: AgentThreadSummary;
  providerLabel: string;
  selected: boolean;
  nowMs: number;
  onSelect: () => void;
}) {
  const pill = threadRailStatus(thread);
  const relative = formatRelativeTime(thread.updatedAt, nowMs);
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
          {relative ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 tabular-nums">{relative}</span>
            </>
          ) : null}
        </span>
      </span>
      {pill ? (
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
          style={{ background: RAIL_TONE_STYLES[pill.tone].background, color: RAIL_TONE_STYLES[pill.tone].color }}
        >
          {pill.label}
        </span>
      ) : null}
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
  onLoadMore,
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
  onLoadMore?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ThreadRailFilter>("all");
  const baseModel = useMemo(
    () => buildProjectThreadListModel(workspace, summary, projectId),
    [projectId, summary, workspace],
  );
  const model = useMemo(
    () => filterProjectThreadListModel(baseModel, query, statusFilter),
    [baseModel, query, statusFilter],
  );
  const canLoadMore = canLoadMoreProjectThreads(workspace);
  const canContinueFilteredSearch = canLoadMore && Boolean(onLoadMore);
  const providerLabel = (thread: AgentThreadSummary) =>
    summary.providers.find((provider) => provider.id === thread.providerId)?.displayName ?? "Agent";
  const isEmpty = model.projectThreads.length === 0
    && model.taskGroups.every((group) => group.threads.length === 0)
    && model.otherThreads.length === 0;
  // Relative timestamps tick once a minute so "2m ago" ages while the rail
  // stays open; rows also re-render on any workspace/summary update.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <nav
      aria-label="Project conversations"
      className="flex min-h-0 w-[clamp(220px,24vw,288px)] shrink-0 flex-col border-r"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
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
          className="rounded p-1 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
          style={{ color: "var(--text-tertiary)" }}
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5 px-2 pb-2">
        <label
          className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 focus-within:ring-2 focus-within:ring-[var(--accent)]"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <Search aria-hidden="true" size={12} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
          <input
            type="text"
            role="searchbox"
            aria-label="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-7 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-xs outline-none placeholder:text-[var(--text-tertiary)]"
            style={{ color: "var(--text-primary)", boxShadow: "none" }}
          />
        </label>
        <select
          aria-label="Filter chats by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as ThreadRailFilter)}
          className="h-7 rounded-md border bg-transparent px-1.5 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-secondary)" }}
        >
          <option value="all">All</option>
          <option value="running">Running</option>
          <option value="waiting">Waiting</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
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
              nowMs={nowMs}
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
                    nowMs={nowMs}
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
                    nowMs={nowMs}
                    onSelect={() => onSelectThread(thread.id)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {isEmpty && status !== "loading" ? (
          <p className="px-2 py-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {query.trim() || statusFilter !== "all"
              ? canContinueFilteredSearch
                ? "No loaded chats match these filters. Load more to search older chats."
                : model.truncated
                  ? "No chats in the current conversation window match these filters."
                  : "No chats match these filters."
              : "No chats yet. Start one with the + button above."}
          </p>
        ) : null}
        {model.truncated ? (
          <div className="px-2 pt-2">
            {canLoadMore && onLoadMore ? (
              <button
                type="button"
                aria-label="Load more chats"
                disabled={status === "loading"}
                onClick={onLoadMore}
                className="w-full rounded-md border px-2 py-1.5 text-[10px] font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
                style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
              >
                {status === "loading" ? "Loading…" : "Load more"}
              </button>
            ) : (
              <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                Showing the current conversation window
              </p>
            )}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
