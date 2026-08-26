import { LayoutGrid, MessageCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { Button, StatusDot } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { DEFAULT_PROJECT_VIEW, useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useUi } from "../../stores/ui";
import type { ProjectView } from "../../stores/project-view";
import Board from "../board/Board";
import CreateTaskDialog from "../board/CreateTaskDialog";
import ProjectChatsView from "./ProjectChatsView";
import ProjectOverview from "./ProjectOverview";

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
  const chatsActive = view !== "board";
  return (
    <div role="group" aria-label="Project view" className="inline-flex rounded-lg border p-0.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      {(["chats", "board"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-label={mode === "board" ? "Board" : "Chats"}
          aria-pressed={mode === "board" ? view === "board" : chatsActive}
          onClick={() => onChange(mode === "board" ? "board" : "overview")}
          title={mode === "board" ? "Board" : "Chats"}
          className="flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{
            background: (mode === "board" ? view === "board" : chatsActive) ? "var(--bg-selected)" : "transparent",
            color: (mode === "board" ? view === "board" : chatsActive) ? "var(--text-primary)" : "var(--text-tertiary)",
          }}
        >
          {mode === "board" ? <LayoutGrid size={14} /> : <MessageCircle size={14} />}
        </button>
      ))}
    </div>
  );
}

/**
 * The project tab: one canonical surface per project with a Board (kanban)
 * and a Chats (coding-agent conversations) view. Later waves attach more
 * The Figma sessions landing and the existing chat detail share the Chats segment;
 * contextual tools remain owned by ProjectChatsView.
 */
export default function ProjectTab({
  projectSlug,
  active,
  initialChatId,
}: {
  projectSlug: string;
  active: boolean;
  initialChatId?: string;
}) {
  const view = useProjectView((s) => s.entries[projectSlug]?.view ?? DEFAULT_PROJECT_VIEW);
  const setView = useProjectView((s) => s.setView);
  const boardProject = useBoard((s) => s.projects.find((project) => project.slug === projectSlug));
  const selectProject = useBoard((s) => s.selectProject);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);
  const refreshWorkspace = useProjectWorkspaces((s) => s.refresh);
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const api = useConnection((s) => s.api);
  const createTaskOpen = useUi((s) => s.createTaskOpen);
  const setCreateTaskOpen = useUi((s) => s.setCreateTaskOpen);
  const projectChatEntryRef = useRef<string | null>(null);

  // The active project owns global task creation in both Board and Chats.
  // Keeping this context at the project-shell level prevents a view switch
  // from unmounting the dialog or leaving it pointed at another project.
  useEffect(() => {
    if (api && active) void selectProject(api, projectSlug);
  }, [active, api, projectSlug, selectProject]);

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

  // Provider authentication can finish in a visible Terminal while the
  // Desktop runtime summary remains cached. Treat every deliberate entry into
  // this project's Chat surface as a readiness boundary: opening/reopening the
  // project, reactivating its tab, or returning from Board checks the provider
  // again. A cold start already owns a fresh bootstrap request above, and the
  // transition guard prevents this from becoming a render-driven polling loop.
  const projectChatEntry = active && view !== "board"
    ? `${runtimeScope}:${projectSlug}`
    : null;
  useEffect(() => {
    if (!projectChatEntry) {
      projectChatEntryRef.current = null;
      return;
    }
    if (projectChatEntryRef.current === projectChatEntry) return;
    projectChatEntryRef.current = projectChatEntry;
    const workspace = useCodingAgentWorkspace.getState();
    if (!workspace.summary || workspace.status === "loading") return;
    void workspace.refresh();
  }, [projectChatEntry]);

  const summaryProject = summary?.projects.items.find((project) => project.id === projectSlug);
  const name = boardProject?.name || summaryProject?.label || projectSlug;
  const description = boardProject?.description;
  const attention = summaryProject?.attentionCount ?? 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view !== "overview" ? <header
        className="flex shrink-0 items-center gap-3 border-b px-5 py-2.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        {summary ? (
          <div className="flex min-w-0 items-center gap-2 rounded-full border px-2.5 py-1" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}>
            <StatusDot
              color={RUNTIME_STATUS_COLOR[summary.runtime.status] ?? "var(--text-tertiary)"}
              pulse={summary.runtime.status === "available"}
            />
            <span className="max-w-44 truncate text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              {summary.runtime.label} Matrix computer
            </span>
          </div>
        ) : null}
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
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              aria-label="Refresh agent workspace"
              onClick={() => {
                void (async () => {
                  await refresh();
                  const currentViewEntry = useProjectView.getState().entries[projectSlug];
                  await refreshWorkspace(projectSlug, {
                    preserveEmptySelection:
                      currentViewEntry !== undefined && currentViewEntry.selectedThreadId === null,
                  });
                })();
              }}
            >
              <RefreshCw size={13} />
            </Button>
          </div>
        ) : null}
      </header> : null}
      {view === "overview" ? (
        <ProjectOverview
          projectId={projectSlug}
          projectLabel={name}
          description={description}
          summary={summary}
          active={active}
          viewSwitch={<ProjectViewSwitch view={view} onChange={(next) => setView(projectSlug, next)} />}
        />
      ) : view === "chats" ? (
        <ProjectChatsView projectId={projectSlug} active={active} initialChatId={initialChatId} />
      ) : (
        <Board projectSlug={projectSlug} active={active} />
      )}
      <CreateTaskDialog open={createTaskOpen && active} onClose={() => setCreateTaskOpen(false)} />
    </div>
  );
}
