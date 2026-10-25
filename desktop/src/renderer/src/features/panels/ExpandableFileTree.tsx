import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder } from "@renderer/lib/hugeicons";
import { FileTypeIcon } from "../files/FileTypeIcon";
import { EMPTY_INSPECTOR_FILE_VIEW, useInspectorFileViews } from "../../stores/files-navigation";
export type InspectorTreeEntry = { path: string; kind: "file" | "directory" };
type InspectorTreeDirectory = { status: "loading" | "ready" | "error"; entries: InspectorTreeEntry[] };
const MAX_EXPANDED_FILE_DIRECTORIES = 200;

export function ExpandableFileTree({
  loadDirectory,
  viewKey,
  onOpenFile,
  selectedPath,
  selectedDirectory = false,
  revealKey,
  renderEntry,
  searchEntries,
}: {
  viewKey?: string;
  loadDirectory: (path: string) => Promise<InspectorTreeEntry[]>;
  onOpenFile: (path: string) => void;
  selectedPath?: string;
  selectedDirectory?: boolean;
  revealKey?: string;
  renderEntry?: (entry: InspectorTreeEntry, button: ReactElement) => ReactNode;
  searchEntries?: (query: string, signal: AbortSignal) => Promise<InspectorTreeEntry[]>;
}) {
  const [initialView] = useState(() => useInspectorFileViews.getState().views.find((entry) => entry.key === viewKey)?.view ?? EMPTY_INSPECTOR_FILE_VIEW);
  const [localExpandedPaths, setLocalExpandedPaths] = useState<string[]>(initialView.expandedPaths);
  const savedExpandedPaths = useInspectorFileViews((state) => state.views.find((entry) => entry.key === viewKey)?.view.expandedPaths ?? EMPTY_INSPECTOR_FILE_VIEW.expandedPaths);
  const expandedPaths = viewKey ? savedExpandedPaths : localExpandedPaths;
  const setExpandedPaths = useCallback((update: (current: string[]) => string[]) => {
    if (!viewKey) { setLocalExpandedPaths(update); return; }
    const current = useInspectorFileViews.getState().views.find((entry) => entry.key === viewKey)?.view.expandedPaths ?? EMPTY_INSPECTOR_FILE_VIEW.expandedPaths;
    useInspectorFileViews.getState().update(viewKey, { expandedPaths: update(current) });
  }, [viewKey]);
  const scrollElement = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef(initialView.scrollTop);
  const restoringScroll = useRef(true);
  const [directories, setDirectories] = useState<Record<string, InspectorTreeDirectory>>({});
  const lifecycleGeneration = useRef(0);
  const requests = useRef(new Map<string, { failed?: boolean }>());
  const selectedElement = useRef<HTMLButtonElement>(null);
  const [localQuery, setLocalQuery] = useState(initialView.query);
  const savedQuery = useInspectorFileViews((state) => state.views.find((entry) => entry.key === viewKey)?.view.query ?? "");
  const query = viewKey ? savedQuery : localQuery;
  const setQuery = (value: string) => viewKey ? useInspectorFileViews.getState().update(viewKey, { query: value }) : setLocalQuery(value);
  const [search, setSearch] = useState<{ query: string; directory: InspectorTreeDirectory } | null>(null);
  const filter = query.trim();
  useEffect(() => {
    if (!filter || !searchEntries) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchEntries(filter, controller.signal).then((entries) => {
        if (!controller.signal.aborted) setSearch({ query: filter, directory: { status: "ready", entries: entries.slice(0, 100) } });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[inspector-files] search unavailable", error instanceof Error ? error.name : "UnknownError");
        setSearch({ query: filter, directory: { status: "error", entries: [] } });
      });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filter, searchEntries]);

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
  }, [loadDirectory, setExpandedPaths]);

  useEffect(() => {
    ensureDirectory("");
    initialView.expandedPaths.forEach(ensureDirectory);
    if (viewKey) useInspectorFileViews.getState().update(viewKey, { treeInitialized: true });
  }, [ensureDirectory, initialView, viewKey]);

  useLayoutEffect(() => {
    const element = scrollElement.current;
    if (!element) return;
    const restore = () => {
      if (element.closest("[hidden]") || !directories[""] || expandedPaths.some((path) => !directories[path] || directories[path].status === "loading")) return;
      element.scrollTop = scrollPosition.current;
      restoringScroll.current = false;
    };
    restore();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    return () => observer.disconnect();
  }, [directories, expandedPaths]);

  const expandedForSelection = useRef(initialView.treeInitialized && !revealKey ? { path: selectedPath, key: revealKey } : undefined);
  useEffect(() => {
    if (!selectedPath || selectedPath === expandedForSelection.current?.path && revealKey === expandedForSelection.current?.key) return;
    expandedForSelection.current = { path: selectedPath, key: revealKey };
    const parts = selectedPath.split("/");
    const parents = (selectedDirectory ? parts : parts.slice(0, -1)).map((_, index) => parts.slice(0, index + 1).join("/"))
      .slice(0, MAX_EXPANDED_FILE_DIRECTORIES - 1);
    setExpandedPaths((current) => [...new Set([...current, ...parents])].slice(-(MAX_EXPANDED_FILE_DIRECTORIES - 1)));
    for (const parent of parents) ensureDirectory(parent);
  }, [ensureDirectory, selectedPath, selectedDirectory, setExpandedPaths, revealKey]);

  const revealedPath = useRef(!revealKey ? { path: selectedPath, key: revealKey } : undefined);
  useEffect(() => {
    if (selectedPath === revealedPath.current?.path && revealKey === revealedPath.current?.key || !selectedElement.current) return;
    selectedElement.current.scrollIntoView?.({ block: "nearest" });
    revealedPath.current = { path: selectedPath, key: revealKey };
  }, [directories, selectedPath, revealKey]);

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      if (current.includes(path)) return current.filter((candidate) => candidate !== path);
      if (current.length >= MAX_EXPANDED_FILE_DIRECTORIES - 1) return current;
      ensureDirectory(path);
      return [...current, path];
    });
  };

  const renderDirectory = (path: string, depth: number) => {
    let directory = path === "" && filter && searchEntries
      ? search?.query === filter ? search.directory : { status: "loading", entries: [] } as InspectorTreeDirectory
      : directories[path];
    if (path === "" && filter && searchEntries) {
      const matches: InspectorTreeEntry[] = [];
      const seen = new Set<string>(); // at most 100 visible search results per render
      const append = (entry: InspectorTreeEntry) => {
        if (matches.length < 100 && !seen.has(entry.path)) { seen.add(entry.path); matches.push(entry); }
      };
      for (const loaded of Object.values(directories)) {
        for (const entry of loaded.entries) {
          if (entry.path.toLowerCase().includes(filter.toLowerCase())) append(entry);
          if (matches.length === 100) break;
        }
        if (matches.length === 100) break;
      }
      for (const entry of directory?.entries ?? []) append(entry);
      if (matches.length) directory = { status: "ready", entries: matches };
    }
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
      const button = <button
            type="button"
            ref={entry.path === selectedPath ? selectedElement : undefined}
            aria-current={entry.path === selectedPath ? true : undefined}
            aria-label={entry.kind === "directory"
              ? `${expanded ? "Collapse" : "Expand"} folder ${entry.path}`
              : `Open file ${entry.path}`}
            {...(entry.kind === "directory" ? { "aria-expanded": expanded } : {})}
            className="flex w-full items-center gap-2.5 truncate rounded-md px-2.5 py-1.5 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            style={{ paddingLeft: 10 + depth * 20, color: "var(--text-primary)", background: entry.path === selectedPath ? "var(--bg-hover)" : undefined }}
            onClick={() => {
              if (entry.kind !== "directory") { onOpenFile(entry.path); return; }
              if (filter) {
                setQuery("");
                const parts = entry.path.split("/");
                const parents = parts.map((_, index) => parts.slice(0, index + 1).join("/")).slice(0, MAX_EXPANDED_FILE_DIRECTORIES - 1);
                parents.forEach(ensureDirectory);
                setExpandedPaths((current) => [...new Set([...current, ...parents])].slice(-(MAX_EXPANDED_FILE_DIRECTORIES - 1)));
              } else toggleDirectory(entry.path);
            }}
          >
            {entry.kind === "directory" ? (
              <>
                {expanded ? <ChevronDown size={15} aria-hidden className="shrink-0" /> : <ChevronRight size={15} aria-hidden className="shrink-0" />}
                <Folder size={15} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
              </>
            ) : <FileTypeIcon filename={entry.path.split("/").at(-1) ?? entry.path} size={15} />}
            <span className="truncate">{entry.path.split("/").at(-1)}</span>
          </button>;
      return (
        <div key={entry.path}>
          {renderEntry ? renderEntry(entry, button) : button}
          {expanded && !filter ? renderDirectory(entry.path, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="files-listing" style={{ background: "var(--bg-surface)" }}>
      {searchEntries ? <div className="shrink-0 border-b p-2" style={{ borderColor: "var(--border-subtle)" }}><input type="search" aria-label="Filter files" placeholder="Filter files…" maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-xs" /></div> : null}
      <div data-files-list-header className="sr-only">Expandable file tree</div>
      <div ref={scrollElement} data-file-tree-scroll className="min-h-0 flex-1 overflow-y-auto" onScroll={(event) => {
        if (restoringScroll.current || event.currentTarget.closest("[hidden]")) return;
        scrollPosition.current = Math.max(0, event.currentTarget.scrollTop);
        if (viewKey) useInspectorFileViews.getState().update(viewKey, { scrollTop: scrollPosition.current });
      }}>
      {renderDirectory("", 0)}
      </div>
    </div>
  );
}

