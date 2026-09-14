import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "@renderer/lib/hugeicons";
import { FileTypeIcon } from "../files/FileTypeIcon";
export type InspectorTreeEntry = { path: string; kind: "file" | "directory" };
type InspectorTreeDirectory = { status: "loading" | "ready" | "error"; entries: InspectorTreeEntry[] };
const MAX_EXPANDED_FILE_DIRECTORIES = 200;

export function ExpandableFileTree({
  loadDirectory,
  onOpenFile,
  selectedPath,
}: {
  loadDirectory: (path: string) => Promise<InspectorTreeEntry[]>;
  onOpenFile: (path: string) => void;
  selectedPath?: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [directories, setDirectories] = useState<Record<string, InspectorTreeDirectory>>({});
  const lifecycleGeneration = useRef(0);
  const requests = useRef(new Map<string, { failed?: boolean }>());
  const selectedElement = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { lifecycleGeneration.current += 1; requests.current.clear(); }, []);

  const ensureDirectory = useCallback((path: string) => {
    if (requests.current.has(path) && !requests.current.get(path)?.failed) return;
    if (requests.current.size >= MAX_EXPANDED_FILE_DIRECTORIES) {
      const oldest = [...requests.current.keys()].find((key) => key !== "");
      if (oldest !== undefined) {
        requests.current.delete(oldest);
        setDirectories(({ [oldest]: _evicted, ...rest }) => rest);
        setExpandedPaths((current) => current.filter((key) => key !== oldest));
      }
    }
    const generation = lifecycleGeneration.current;
    const request: { failed?: boolean } = {};
    requests.current.set(path, request);
    setDirectories((current) => ({ ...current, [path]: { status: "loading", entries: [] } }));
    void loadDirectory(path).then((entries) => {
      if (generation !== lifecycleGeneration.current || requests.current.get(path) !== request) return;
      setDirectories((current) => ({ ...current, [path]: { status: "ready", entries } }));
    }).catch((failure: unknown) => {
      console.warn("[inspector-files] directory unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (generation !== lifecycleGeneration.current || requests.current.get(path) !== request) return;
      request.failed = true;
      setDirectories((current) => ({ ...current, [path]: { status: "error", entries: [] } }));
    });
  }, [loadDirectory]);

  useEffect(() => { ensureDirectory(""); }, [ensureDirectory]);

  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
      .slice(0, MAX_EXPANDED_FILE_DIRECTORIES - 1);
    setExpandedPaths((current) => [...new Set([...current, ...parents])].slice(-(MAX_EXPANDED_FILE_DIRECTORIES - 1)));
    for (const parent of parents) ensureDirectory(parent);
  }, [ensureDirectory, selectedPath]);

  useEffect(() => {
    selectedElement.current?.scrollIntoView?.({ block: "nearest" });
  }, [directories, selectedPath]);

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      if (current.includes(path)) return current.filter((candidate) => candidate !== path);
      if (current.length >= MAX_EXPANDED_FILE_DIRECTORIES - 1) return current;
      ensureDirectory(path);
      return [...current, path];
    });
  };

  const renderDirectory = (path: string, depth: number) => {
    const directory = directories[path];
    if (!directory || directory.status === "loading") {
      return <p className="px-3 py-2 text-xs" style={{ paddingLeft: 12 + depth * 16, color: "var(--text-tertiary)" }}>Loading files…</p>;
    }
    if (directory.status === "error") {
      return <p className="px-3 py-2 text-xs" style={{ paddingLeft: 12 + depth * 16, color: "var(--danger)" }}>Files are unavailable.</p>;
    }
    if (directory.entries.length === 0) {
      return depth === 0
        ? <p className="p-3 text-xs" style={{ color: "var(--text-tertiary)" }}>No files.</p>
        : <p className="px-3 py-1.5 text-xs" style={{ paddingLeft: 28 + depth * 16, color: "var(--text-tertiary)" }}>Empty folder</p>;
    }
    return directory.entries.map((entry) => {
      const expanded = entry.kind === "directory" && expandedPaths.includes(entry.path);
      return (
        <div key={entry.path}>
          <button
            type="button"
            ref={entry.path === selectedPath ? selectedElement : undefined}
            aria-current={entry.path === selectedPath ? true : undefined}
            aria-label={entry.kind === "directory"
              ? `${expanded ? "Collapse" : "Expand"} folder ${entry.path}`
              : `Open file ${entry.path}`}
            {...(entry.kind === "directory" ? { "aria-expanded": expanded } : {})}
            className="flex w-full items-center gap-2.5 truncate rounded-md px-2.5 py-1.5 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            style={{ paddingLeft: 10 + depth * 20, color: "var(--text-primary)", background: entry.path === selectedPath ? "var(--bg-hover)" : undefined }}
            onClick={() => entry.kind === "directory" ? toggleDirectory(entry.path) : onOpenFile(entry.path)}
          >
            {entry.kind === "directory" ? (
              <>
                {expanded ? <ChevronDown size={15} aria-hidden className="shrink-0" /> : <ChevronRight size={15} aria-hidden className="shrink-0" />}
                <Folder size={15} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
              </>
            ) : <FileTypeIcon filename={entry.path.split("/").at(-1) ?? entry.path} size={15} />}
            <span className="truncate">{entry.path.split("/").at(-1)}</span>
          </button>
          {expanded ? renderDirectory(entry.path, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="files-listing" style={{ background: "var(--bg-surface)" }}>
      <div data-files-list-header className="sr-only">Expandable file tree</div>
      {renderDirectory("", 0)}
    </div>
  );
}

