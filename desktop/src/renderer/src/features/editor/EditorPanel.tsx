import { Code2, Eye, FileCode2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useEditorTabs } from "./editor-tabs-store";

const CodeMirrorHost = lazy(() => import("./CodeMirrorHost"));
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

// Stable empty reference: a selector returning a fresh [] every render would
// fail the Object.is check and loop forever (React #185, CLAUDE.md rule).
const EMPTY_TABS: string[] = [];
const EMPTY_DIRTY_PATHS: string[] = [];

const isMarkdown = (path: string): boolean => /\.mdx?$/i.test(path);

export default function EditorPanel({ taskId }: { taskId: string }) {
  const api = useConnection((s) => s.api);
  const tabs = useEditorTabs((s) => s.tabsByTask[taskId] ?? EMPTY_TABS);
  const activePath = useEditorTabs((s) => s.activePathByTask[taskId] ?? null);
  const setActive = useEditorTabs((s) => s.setActive);
  const closeTab = useEditorTabs((s) => s.closeTab);
  const dirtyPaths = useEditorTabs((s) => s.dirtyPathsByTask[taskId] ?? EMPTY_DIRTY_PATHS);
  // Per-path "edit this markdown as code" overrides; markdown previews by default.
  const [editPaths, setEditPaths] = useState<Record<string, boolean>>({});

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={<FileCode2 size={24} />}
        headline="No file open"
        description="Open a file from the file browser or press ⌘P to quick-open."
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1 pt-1"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {tabs.map((path) => {
          const name = path.split("/").pop() ?? path;
          const active = path === activePath;
          const dirty = dirtyPaths.includes(path);
          return (
            <div
              key={path}
              className="flex max-w-[180px] items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1.5 text-sm"
              style={{
                background: active ? "var(--bg-raised)" : "transparent",
                borderColor: active ? "var(--border-subtle)" : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-tertiary)",
              }}
            >
              <button
                type="button"
                className="min-w-0 truncate"
                title={path}
                onClick={() => setActive(taskId, path)}
              >
                {name}
              </button>
              {dirty ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--accent)" }} />
              ) : null}
              <button
                type="button"
                aria-label={`Close ${name}`}
                className="shrink-0 rounded p-0.5 hover:bg-[var(--bg-hover)]"
                onClick={() => closeTab(taskId, path)}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        {activePath && isMarkdown(activePath) ? (
          <button
            type="button"
            className="no-drag ml-auto mr-1 mb-1 flex items-center gap-1.5 self-center rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
            onClick={() => setEditPaths((m) => ({ ...m, [activePath]: !m[activePath] }))}
            title={editPaths[activePath] ? "Preview rendered markdown" : "Edit as code"}
          >
            {editPaths[activePath] ? <Eye size={12} /> : <Code2 size={12} />}
            {editPaths[activePath] ? "Preview" : "Edit"}
          </button>
        ) : null}
      </div>
      {activePath && api ? (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <span className="status-pulse text-xs" style={{ color: "var(--text-tertiary)" }}>
                Loading…
              </span>
            </div>
          }
        >
          {isMarkdown(activePath) && !editPaths[activePath] ? (
            <MarkdownPreview key={`md:${activePath}`} path={activePath} />
          ) : (
            <CodeMirrorHost key={activePath} taskId={taskId} path={activePath} />
          )}
        </Suspense>
      ) : null}
    </div>
  );
}

export function useEditorOpenFile(taskId: string) {
  const openTab = useEditorTabs((s) => s.openTab);
  return useCallback((path: string) => openTab(taskId, path), [openTab, taskId]);
}

export function ConflictBar({
  onOverwrite,
  onReload,
  busy = false,
}: {
  onOverwrite: () => void;
  onReload: () => void;
  busy?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-t px-3 py-2"
      style={{ background: "var(--warning-muted)", borderColor: "var(--border-default)" }}
    >
      <span className="text-sm" style={{ color: "var(--warning)" }}>
        This file changed on your computer since you opened it.
      </span>
      <div className="flex gap-2">
        <Button variant="subtle" disabled={busy} onClick={onReload}>
          Reload
        </Button>
        <Button variant="danger" disabled={busy} onClick={onOverwrite}>
          Overwrite
        </Button>
      </div>
    </div>
  );
}

// Small per-task editor tab state, kept separate from the workspace store so
// panel layout and file tabs evolve independently.
export function useAutosaveShortcut(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  const [, force] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        ref.current();
        force((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
