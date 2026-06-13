import {
  Activity,
  FileCode2,
  FolderTree,
  GitBranch,
  Globe,
  ListTree,
  Package,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";
import { useSessions } from "../../stores/sessions";
import { useWorkspace, type PanelKind } from "../../stores/workspace";
import EditorPanel from "../editor/EditorPanel";
import FilesPanel from "../files/FilesPanel";
import GitPanel from "../git/GitPanel";
import TerminalView from "../terminal/TerminalView";
import { getAttachManager } from "../terminal/terminal-runtime";
import ArtifactsPanel from "./ArtifactsPanel";
import PanelStrip, { PANEL_TITLES } from "./PanelStrip";
import ProcessesPanel from "./ProcessesPanel";
import StartSessionControls from "./StartSessionControls";
import TimelinePanel from "./TimelinePanel";

const PANEL_ICONS: Record<PanelKind, React.ReactNode> = {
  terminal: <SquareTerminal size={14} />,
  editor: <FileCode2 size={14} />,
  git: <GitBranch size={14} />,
  browser: <FolderTree size={14} />,
  artifacts: <Package size={14} />,
  processes: <Activity size={14} />,
  timeline: <ListTree size={14} />,
};

const PANEL_SHORTCUT_ORDER: PanelKind[] = [
  "terminal",
  "editor",
  "git",
  "browser",
  "artifacts",
  "processes",
  "timeline",
];

export default function TaskWorkspace({ taskId, active = true }: { taskId: string; active?: boolean }) {
  const api = useConnection((s) => s.api);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const sessionsLoad = useSessions((s) => s.load);
  const aliasMap = useSessions((s) => s.aliasMap);
  const sessionList = useSessions((s) => s.sessions);
  const worktrees = useGit((s) => s.worktrees);
  const previews = useGit((s) => s.previews);
  const gitLoadAll = useGit((s) => s.loadAll);
  const gitLoadPreviews = useGit((s) => s.loadPreviews);
  const openTask = useWorkspace((s) => s.openTask);
  const focusTask = useWorkspace((s) => s.focusTask);
  const togglePanel = useWorkspace((s) => s.togglePanel);
  const layouts = useWorkspace((s) => s.layouts);
  const layoutFor = useWorkspace((s) => s.layoutFor);

  const card = useMemo(() => {
    for (const cards of Object.values(cardsByProject)) {
      const found = cards.find((c) => c.id === taskId);
      if (found) return found;
    }
    return null;
  }, [cardsByProject, taskId]);

  const projectSlug = card?.projectSlug ?? null;

  useEffect(() => {
    if (api) void sessionsLoad(api);
  }, [api, sessionsLoad]);

  // Worktree + preview state powers the task header chips (branch/dirty/preview
  // health). Scoped to this task's project so the header reflects live work.
  useEffect(() => {
    if (!api || !projectSlug) return;
    void gitLoadAll(api, projectSlug);
    void gitLoadPreviews(api, projectSlug, taskId);
  }, [api, projectSlug, taskId, gitLoadAll, gitLoadPreviews]);

  useEffect(() => {
    // LRU eviction releases attach buffers for tasks pushed out of the cap.
    const { evicted } = openTask(taskId);
    const manager = getAttachManager();
    const aliases = useSessions.getState().aliasMap;
    for (const evictedTaskId of evicted) {
      const evictedCard = Object.values(useBoard.getState().cardsByProject)
        .flat()
        .find((c) => c.id === evictedTaskId);
      const attachName = evictedCard?.linkedSessionId
        ? aliases[evictedCard.linkedSessionId]
        : null;
      if (attachName) manager.releaseSession(attachName);
    }
    focusTask(taskId);
  }, [taskId, openTask, focusTask]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const index = Number.parseInt(e.key, 10);
      if (Number.isInteger(index) && index >= 1 && index <= PANEL_SHORTCUT_ORDER.length) {
        e.preventDefault();
        togglePanel(taskId, PANEL_SHORTCUT_ORDER[index - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, togglePanel]);

  const attachName = card?.linkedSessionId ? (aliasMap[card.linkedSessionId] ?? null) : null;
  const layout = layouts[taskId] ?? layoutFor(taskId);

  // Header chips: live session, worktree branch/dirty, preview health.
  const sessionLive = attachName
    ? sessionList.some((s) => s.attachName === attachName && s.status === "active")
    : false;
  const worktree = useMemo(
    () => (card?.linkedWorktreeId ? worktrees.find((w) => w.id === card.linkedWorktreeId) ?? null : null),
    [worktrees, card?.linkedWorktreeId],
  );
  const taskPreviews = useMemo(
    () => previews.filter((p) => p.taskId === taskId),
    [previews, taskId],
  );
  const previewHealth: "ok" | "failed" | "unknown" | null =
    taskPreviews.length === 0
      ? null
      : taskPreviews.some((p) => p.lastStatus === "failed")
        ? "failed"
        : taskPreviews.every((p) => p.lastStatus === "ok")
          ? "ok"
          : "unknown";
  const previewColor =
    previewHealth === "ok" ? "var(--success)" : previewHealth === "failed" ? "var(--danger)" : "var(--text-tertiary)";

  const renderPanel = (panel: PanelKind): React.ReactNode => {
    switch (panel) {
      case "terminal":
        return attachName ? (
          <TerminalView sessionName={attachName} active={active} />
        ) : (
          <EmptyState
            icon={<SquareTerminal size={22} />}
            headline="No live session"
            description={
              card?.linkedSessionId
                ? "This task's session has ended. Start a new one on your cloud computer."
                : "Start a cloud terminal or coding agent for this task."
            }
            action={
              projectSlug && card ? (
                <StartSessionControls
                  projectSlug={projectSlug}
                  taskId={taskId}
                  worktreeId={card.linkedWorktreeId}
                  title={card.title}
                  description={card.description}
                />
              ) : null
            }
          />
        );
      case "editor":
        return <EditorPanel taskId={taskId} />;
      case "git":
        return projectSlug ? <GitPanel projectSlug={projectSlug} /> : null;
      case "browser":
        return <FilesPanel taskId={taskId} />;
      case "artifacts":
        return projectSlug ? <ArtifactsPanel projectSlug={projectSlug} taskId={taskId} /> : null;
      case "processes":
        return <ProcessesPanel />;
      case "timeline":
        return <TimelinePanel taskId={taskId} />;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <span className="min-w-0 max-w-[40%] truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {card?.title ?? "Task"}
        </span>

        {/* Work-state chips: session, worktree/branch + dirty, preview health. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {attachName ? (
            <span
              className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
              style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
              title={sessionLive ? "Live session" : "Session ended"}
            >
              <StatusDot color={sessionLive ? "var(--success)" : "var(--text-tertiary)"} pulse={sessionLive} />
              <span className="font-mono">{attachName}</span>
            </span>
          ) : null}
          {worktree ? (
            <span
              className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
              title={worktree.dirtyState === "dirty" ? "Uncommitted changes" : "Clean working tree"}
            >
              <GitBranch size={11} />
              <span className="max-w-[140px] truncate font-mono">{worktree.currentBranch ?? worktree.sourceBranch ?? "worktree"}</span>
              {worktree.dirtyCount ? (
                <span style={{ color: "var(--highlight)" }}>±{worktree.dirtyCount}</span>
              ) : null}
            </span>
          ) : null}
          {previewHealth ? (
            <span
              className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              style={{ borderColor: "var(--border-default)", color: previewColor }}
              title={`Preview ${previewHealth}`}
            >
              <Globe size={11} />
              {taskPreviews.length}
            </span>
          ) : null}
        </div>

        {projectSlug && card ? (
          <StartSessionControls
            projectSlug={projectSlug}
            taskId={taskId}
            worktreeId={card.linkedWorktreeId}
            title={card.title}
            description={card.description}
            compact
          />
        ) : null}

        <div className="flex items-center gap-0.5">
          {PANEL_SHORTCUT_ORDER.map((panel, i) => (
            <IconButton
              key={panel}
              label={`${PANEL_TITLES[panel]} (⌘${i + 1})`}
              active={Boolean(layout.visible[panel])}
              onClick={() => togglePanel(taskId, panel)}
            >
              {PANEL_ICONS[panel]}
            </IconButton>
          ))}
        </div>
      </div>
      <PanelStrip taskId={taskId} renderPanel={renderPanel} />
    </div>
  );
}
