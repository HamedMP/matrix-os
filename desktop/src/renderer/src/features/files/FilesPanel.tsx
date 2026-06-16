import { ChevronDown, ChevronRight, File, Folder, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { IconButton } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useWorkspace } from "../../stores/workspace";
import { useEditorTabs } from "../editor/editor-tabs-store";

interface Entry {
  name: string;
  type: "file" | "directory";
}

function parseEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  const entries: Entry[] = [];
  for (const raw of value.slice(0, 500)) {
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as Entry).name === "string" &&
      ((raw as Entry).type === "file" || (raw as Entry).type === "directory")
    ) {
      entries.push({ name: (raw as Entry).name, type: (raw as Entry).type });
    }
  }
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
  );
}

function TreeNode({
  path,
  name,
  depth,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  const api = useConnection((s) => s.api);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
    if (!children && api) {
      api
        .get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`)
        .then((res) => setChildren(parseEntries(res.entries)))
        .catch((err: unknown) => {
          console.warn("[files] list failed:", err instanceof Error ? err.message : String(err));
          setChildren([]);
        });
    }
  }, [api, children, path]);

  return (
    <>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-[var(--bg-hover)]"
        style={{ paddingLeft: 6 + depth * 14, color: "var(--text-secondary)" }}
        onClick={toggle}
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
                onOpenFile={onOpenFile}
              />
            ) : (
              <button
                key={childPath}
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-[var(--bg-hover)]"
                style={{ paddingLeft: 6 + (depth + 1) * 14 + 14, color: "var(--text-secondary)" }}
                onClick={() => onOpenFile(childPath)}
              >
                <File size={13} style={{ color: "var(--text-tertiary)" }} />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })
        : null}
    </>
  );
}

export default function FilesPanel({ taskId }: { taskId: string }) {
  const api = useConnection((s) => s.api);
  const openTab = useEditorTabs((s) => s.openTab);
  const [roots, setRoots] = useState<Entry[] | null>(null);

  const loadRoots = useCallback(() => {
    if (!api) return;
    api
      .get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent("")}`)
      .then((res) => setRoots(parseEntries(res.entries)))
      .catch((err: unknown) => {
        console.warn("[files] root list failed:", err instanceof Error ? err.message : String(err));
        setRoots([]);
      });
  }, [api]);

  useEffect(() => {
    if (roots === null) loadRoots();
  }, [loadRoots, roots]);

  const onOpenFile = useCallback(
    (path: string) => {
      openTab(taskId, path);
      const workspace = useWorkspace.getState();
      if (!workspace.layoutFor(taskId).visible.editor) {
        workspace.togglePanel(taskId, "editor");
      }
    },
    [openTab, taskId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
          Files
        </span>
        <IconButton label="Refresh files" onClick={loadRoots}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      {roots?.map((entry) =>
        entry.type === "directory" ? (
          <TreeNode key={entry.name} path={entry.name} name={entry.name} depth={0} onOpenFile={onOpenFile} />
        ) : (
          <button
            key={entry.name}
            type="button"
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-[var(--bg-hover)]"
            style={{ paddingLeft: 20, color: "var(--text-secondary)" }}
            onClick={() => onOpenFile(entry.name)}
          >
            <File size={13} style={{ color: "var(--text-tertiary)" }} />
            <span className="truncate">{entry.name}</span>
          </button>
        ),
      )}
    </div>
  );
}
