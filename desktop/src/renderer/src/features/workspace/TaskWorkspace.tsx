import {
  Activity,
  FileCode2,
  FolderTree,
  GitBranch,
  Package,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button, EmptyState, IconButton } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
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

const PANEL_ICONS: Record<PanelKind, React.ReactNode> = {
  terminal: <SquareTerminal size={14} />,
  editor: <FileCode2 size={14} />,
  git: <GitBranch size={14} />,
  browser: <FolderTree size={14} />,
  artifacts: <Package size={14} />,
  processes: <Activity size={14} />,
};

const PANEL_SHORTCUT_ORDER: PanelKind[] = [
  "terminal",
  "editor",
  "git",
  "browser",
  "artifacts",
  "processes",
];

function warnSessionLoadFailure(err: unknown): void {
  console.warn("[task-workspace] load sessions failed:", err instanceof Error ? err.message : String(err));
}

export default function TaskWorkspace({ taskId, active = true }: { taskId: string; active?: boolean }) {
  const api = useConnection((s) => s.api);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const sessionsLoad = useSessions((s) => s.load);
  const aliasMap = useSessions((s) => s.aliasMap);
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
    if (api) void sessionsLoad(api).catch(warnSessionLoadFailure);
  }, [api, sessionsLoad]);

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
                ? "This task's session has ended on your computer."
                : "This task has no linked terminal session yet."
            }
            action={
              <Button
                variant="primary"
                onClick={() => {
                  if (api) void sessionsLoad(api).catch(warnSessionLoadFailure);
                }}
              >
                Refresh sessions
              </Button>
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
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {card?.title ?? "Task"}
        </span>
        {attachName ? (
          <span
            className="rounded-full border px-2 py-0.5 font-mono text-xs"
            style={{ borderColor: "var(--border-default)", color: "var(--text-tertiary)" }}
          >
            {attachName}
          </span>
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
