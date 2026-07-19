import { FolderKanban, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { Button, StatusDot } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import type { ProjectView } from "../../stores/project-view";
import Board from "../board/Board";
import ProjectChatsView from "./ProjectChatsView";

const RUNTIME_STATUS_COLOR: Record<string, string> = {
  available: "var(--success)",
  running: "var(--success)",
  degraded: "var(--warning)",
  offline: "var(--danger)",
  failed: "var(--danger)",
  unavailable: "var(--danger)",
  unknown: "var(--text-tertiary)",
};

export function ProjectViewSwitch({
  view,
  onChange,
}: {
  view: ProjectView;
  onChange: (view: ProjectView) => void;
}) {
  return (
    <div role="group" aria-label="Project view" className="inline-flex rounded-lg border p-0.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      {(["board", "chats"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-label={mode === "board" ? "Board" : "Chats"}
          aria-pressed={view === mode}
          onClick={() => onChange(mode)}
          className="rounded-md px-3 py-1.5 text-xs font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{
            background: view === mode ? "var(--bg-selected)" : "transparent",
            color: view === mode ? "var(--text-primary)" : "var(--text-tertiary)",
          }}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

/**
 * The project tab: one canonical surface per project with a Board (kanban)
 * and a Chats (coding-agent conversations) view. Later waves attach more
 * panels (git DAG, files, terminal) to this header/segmented structure.
 */
export default function ProjectTab({ projectSlug, active }: { projectSlug: string; active: boolean }) {
  const view = useProjectView((s) => s.entries[projectSlug]?.view ?? "board");
  const setView = useProjectView((s) => s.setView);
  const boardProject = useBoard((s) => s.projects.find((project) => project.slug === projectSlug));
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);
  const refreshWorkspace = useProjectWorkspaces((s) => s.refresh);
  const runtimeScope = useConnection(codingAgentRuntimeScope);

  // Restore the per-project view/chat selection for this computer.
  useEffect(() => {
    void useProjectView.getState().hydrate(runtimeScope);
  }, [runtimeScope]);

  // Self-sufficiency bootstrap (tests, future embeds): when no shell bootstrap
  // has loaded the runtime summary yet, load it here so the header's runtime
  // status and the Chats view have data. MissionControl normally wins this.
  useEffect(() => {
    const workspace = useCodingAgentWorkspace.getState();
    if (workspace.status !== "idle" || workspace.summary) return;
    void workspace.refresh().then(() => {
      const current = useCodingAgentWorkspace.getState();
      if (current.notificationPreferencesStatus === "idle") {
        void current.loadNotificationPreferences();
      }
    });
  }, []);

  const summaryProject = summary?.projects.items.find((project) => project.id === projectSlug);
  const name = boardProject?.name || summaryProject?.label || projectSlug;
  const attention = summaryProject?.attentionCount ?? 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}>
          <FolderKanban size={13} />
        </span>
        <span className="truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{name}</span>
        {attention > 0 ? (
          <span
            aria-label={`${attention} need attention`}
            className="shrink-0 rounded-full px-1.5 text-xs"
            style={{ background: "var(--highlight-muted)", color: "var(--highlight)" }}
          >
            {attention}
          </span>
        ) : null}
        <div className="flex-1" />
        <ProjectViewSwitch view={view} onChange={(next) => setView(projectSlug, next)} />
        {summary ? (
          <div className="flex shrink-0 items-center gap-2">
            <StatusDot
              color={RUNTIME_STATUS_COLOR[summary.runtime.status] ?? "var(--text-tertiary)"}
              pulse={summary.runtime.status === "available"}
            />
            <span className="max-w-32 truncate text-xs" style={{ color: "var(--text-secondary)" }}>
              {summary.runtime.label}
            </span>
            <Button
              variant="ghost"
              aria-label="Refresh agent workspace"
              onClick={() => {
                void (async () => {
                  await refresh();
                  await refreshWorkspace(projectSlug);
                })();
              }}
            >
              <RefreshCw size={13} />
            </Button>
          </div>
        ) : null}
      </header>
      {view === "chats" ? (
        <ProjectChatsView projectId={projectSlug} active={active} />
      ) : (
        <Board projectSlug={projectSlug} active={active} />
      )}
    </div>
  );
}
