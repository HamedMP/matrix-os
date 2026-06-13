import { ChevronDown, ChevronRight, File, Folder, RefreshCw } from "lucide-react";
import { useCallback, useEffect } from "react";
import { IconButton } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useFileTree, type FileEntry } from "../../stores/file-tree";
import { useEditorTabs } from "../editor/editor-tabs-store";

function TreeNode({
  path,
  name,
  depth,
  activePath,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const api = useConnection((s) => s.api);
  const expanded = useFileTree((s) => s.expanded[path] ?? false);
  const children = useFileTree((s) => s.childrenByPath[path]);
  const toggle = useFileTree((s) => s.toggle);

  return (
    <>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-[var(--bg-hover)]"
        style={{ paddingLeft: 6 + depth * 14, color: "var(--text-secondary)" }}
        onClick={() => {
          if (api) void toggle(api, path);
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={13} style={{ color: "var(--text-tertiary)" }} />
        <span className="truncate" style={{ color: "var(--text-primary)" }}>
          {name}
        </span>
      </button>
      {expanded && children
        ? children.map((entry) => {
            const childPath = path ? `${path}/${entry.name}` : entry.name;
            return entry.type === "directory" ? (
              <TreeNode
                key={childPath}
                path={childPath}
                name={entry.name}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            ) : (
              <FileRow
                key={childPath}
                path={childPath}
                name={entry.name}
                depth={depth + 1}
                active={childPath === activePath}
                onOpenFile={onOpenFile}
              />
            );
          })
        : null}
    </>
  );
}

function FileRow({
  path,
  name,
  depth,
  active,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
  active: boolean;
  onOpenFile: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm"
      style={{
        paddingLeft: 6 + depth * 14 + 14,
        background: active ? "var(--bg-selected)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
      onClick={() => onOpenFile(path)}
    >
      <File size={13} style={{ color: "var(--text-tertiary)" }} />
      <span className="truncate">{name}</span>
    </button>
  );
}

export default function FilesPanel({ taskId }: { taskId: string }) {
  const api = useConnection((s) => s.api);
  const openTab = useEditorTabs((s) => s.openTab);
  const activePath = useEditorTabs((s) => s.activePathByTask[taskId] ?? null);
  const roots = useFileTree((s) => s.roots);
  const loadRoots = useFileTree((s) => s.loadRoots);

  useEffect(() => {
    if (api) void loadRoots(api);
  }, [api, loadRoots]);

  const refresh = useCallback(() => {
    if (api) void loadRoots(api, true);
  }, [api]);

  const onOpenFile = useCallback((path: string) => openTab(taskId, path), [openTab, taskId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
          Files
        </span>
        <IconButton label="Refresh files" onClick={refresh}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      {roots?.map((entry: FileEntry) =>
        entry.type === "directory" ? (
          <TreeNode key={entry.name} path={entry.name} name={entry.name} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
        ) : (
          <FileRow key={entry.name} path={entry.name} name={entry.name} depth={0} active={entry.name === activePath} onOpenFile={onOpenFile} />
        ),
      )}
    </div>
  );
}
