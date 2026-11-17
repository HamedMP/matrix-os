"use client";
import { useEffect, useState } from "react";
import { ChevronRight, FileCode2, Folder, FolderOpen } from "lucide-react";
import { ChatInspectorFileRoot } from "@matrix-os/ui";
import { z } from "zod/v4";

const FileEntrySchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.enum(["file", "directory"]),
  })
  .passthrough();
const FileListSchema = z.union([
  z.object({ entries: z.array(FileEntrySchema) }).passthrough(),
  z.array(FileEntrySchema),
]);
type FileEntry = z.infer<typeof FileEntrySchema>;

function FileBranch({
  gatewayUrl,
  path,
  depth,
  expanded,
  toggle,
  query,
  onOpenFile,
  selectedPath,
  revealKey,
}: {
  gatewayUrl: string;
  path: string;
  depth: number;
  expanded: readonly string[];
  toggle(path: string): void;
  query: string;
  selectedPath?: string;
  revealKey?: object;
  onOpenFile(path: string): void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [range, setRange] = useState({ start: 0, total: 0 });
  const [page, setPage] = useState<{ query: string; start: number; selection?: string; request?: object }>({ query: "", start: 0 });
  const offset = page.query === query && page.selection === selectedPath && page.request === revealKey ? page.start : undefined;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setEntries([]);
    void fetch(`${gatewayUrl}/api/files/list?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("FileListUnavailable");
        return FileListSchema.parse(await response.json());
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        const all = Array.isArray(data) ? data : data.entries;
        // The existing endpoint returns the directory. Retain only one window, filtering before slicing.
        const matching = all.filter(entry => entry.type === "directory" || entry.name.toLowerCase().includes(query.toLowerCase()))
          .sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
        const selected = !query && offset === undefined ? matching.findIndex(entry => (path ? `${path}/${entry.name}` : entry.name) === selectedPath) : -1;
        const requested = offset ?? (selected < 0 ? 0 : Math.floor(selected / 1000) * 1000);
        const start = Math.min(requested, Math.floor(Math.max(0, matching.length - 1) / 1000) * 1000);
        setEntries(matching.slice(start, start + 1000));
        setRange({ start, total: matching.length });
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("[chat-inspector] Files unavailable:", cause instanceof Error ? cause.name : "UnknownError");
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [gatewayUrl, path, retry, query, offset, selectedPath, revealKey]);
  return (
    <div role={depth ? "group" : "tree"} aria-label={depth ? undefined : "Chat files"} className="min-w-0">
      {status === "loading" ? (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          Loading files…
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="px-3 py-1 text-xs">
          Files could not be loaded.{" "}
          <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </p>
      ) : null}
      {range.total > 1000 ? <div role="group" aria-label={`File pages in ${path || "Home"}`} className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
        <span>Showing {range.start + 1}–{Math.min(range.start + 1000, range.total)} of {range.total} files.</span>
        {range.start > 0 ? <button type="button" disabled={status === "loading"} aria-label={`Previous files in ${path || "Home"}`} onClick={() => setPage({ query, start: Math.max(0, range.start - 1000), selection: selectedPath, request: revealKey })}>Previous</button> : null}
        {range.start + 1000 < range.total ? <button type="button" disabled={status === "loading"} aria-label={`Next files in ${path || "Home"}`} onClick={() => setPage({ query, start: range.start + 1000, selection: selectedPath, request: revealKey })}>Next</button> : null}
      </div> : null}
      {entries
        .filter((entry) => entry.type === "directory" || entry.name.toLowerCase().includes(query.toLowerCase()))
        .map((entry) => {
          const fullPath = path ? `${path}/${entry.name}` : entry.name;
          const open = expanded.includes(fullPath);
          const directory = entry.type === "directory";
          return (
            <div key={entry.name}>
              <button
                type="button"
                role="treeitem"
                aria-label={entry.name}
                aria-expanded={directory ? open : undefined}
                aria-selected={!directory ? selectedPath === fullPath : undefined}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-3 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                style={{ paddingLeft: 12 + depth * 16 }}
                onClick={() => (directory ? toggle(fullPath) : onOpenFile(fullPath))}
              >
                {directory ? (
                  <ChevronRight size={12} aria-hidden className={open ? "rotate-90" : ""} />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                {directory ? (
                  open ? (
                    <FolderOpen size={14} aria-hidden />
                  ) : (
                    <Folder size={14} aria-hidden />
                  )
                ) : (
                  <FileCode2 size={14} aria-hidden />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              {directory && open && depth < 12 ? (
                <FileBranch
                  gatewayUrl={gatewayUrl}
                  path={fullPath}
                  depth={depth + 1}
                  expanded={expanded}
                  toggle={toggle}
                  query={query}
                  selectedPath={selectedPath}
                  revealKey={revealKey}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </div>
          );
        })}
    </div>
  );
}
function FileTree({
  gatewayUrl,
  rootPath = "",
  rootLabel = "Matrix Home",
  selectedPath,
  revealKey,
  onOpenFile,
}: {
  gatewayUrl: string;
  rootPath?: string;
  rootLabel?: string;
  selectedPath?: string;
  revealKey?: object;
  onOpenFile(path: string): void;
}) {
  const parents = () => {
    const parts = selectedPath?.split("/") ?? [];
    return parts.slice(0,-1).map((_, index) => [rootPath, ...parts.slice(0,index+1)].filter(Boolean).join("/")).slice(-20);
  };
  const [expanded, setExpanded] = useState<string[]>(parents);
  useEffect(() => {
    const reveal = parents();
    if (reveal.length) setExpanded(current => [...current.filter(path => !reveal.includes(path)), ...reveal].slice(-20));
    // Each file-open request reveals its ancestors, including reopening the same path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, selectedPath, revealKey]);
  const [query, setQuery] = useState("");
  const toggle = (path: string) =>
    setExpanded((current) =>
      current.includes(path)
        ? current.filter((value) => value !== path && !value.startsWith(path + "/"))
        : [...current.slice(-19), path],
    );
  return (
    <>
      <ChatInspectorFileRoot label={rootLabel} value={query} onChange={setQuery}/>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <FileBranch
          key={rootPath}
          gatewayUrl={gatewayUrl}
          path={rootPath}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          query={query}
          selectedPath={selectedPath ? [rootPath, selectedPath].filter(Boolean).join("/") : undefined}
          revealKey={revealKey}
          onOpenFile={onOpenFile}
        />
      </div>
    </>
  );
}

export function WebChatFileTree({
  gatewayUrl,
  project,
  selectedPath,
  revealKey,
  onOpenFile,
}: {
  gatewayUrl: string;
  project?: { id: string; slug: string };
  selectedPath?: string;
  revealKey?: object;
  onOpenFile(path: string): void;
}) {
  const [root, setRoot] = useState<string | null>(null),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    void fetch(
      `${gatewayUrl}/api/projects/${encodeURIComponent(project.slug)}/files-location?projectId=${encodeURIComponent(project.id)}`,
      {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("ProjectFilesUnavailable");
        return z.object({ path: z.string().max(4096) }).parse(await response.json());
      })
      .then((value) => {
        if (!controller.signal.aborted) {
          setRoot(value.path);
          setError(false);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(
            "[chat-inspector] Project files unavailable:",
            cause instanceof Error ? cause.name : "UnknownError",
          );
          setError(true);
        }
      });
    return () => controller.abort();
  }, [gatewayUrl, project, attempt]);
  if (!project) return <FileTree gatewayUrl={gatewayUrl} selectedPath={selectedPath} revealKey={revealKey} onOpenFile={onOpenFile} />;
  if (error)
    return (
      <p role="alert" className="p-3 text-sm">
        Project files could not be loaded.{" "}
        <button
          className="underline"
          onClick={() => {
            setError(false);
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </button>
      </p>
    );
  if (root === null)
    return (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        Loading project files…
      </p>
    );
  return <FileTree gatewayUrl={gatewayUrl} rootLabel={project.slug} rootPath={root} selectedPath={selectedPath} revealKey={revealKey} onOpenFile={path => onOpenFile(path.slice(root.length + 1))} />;
}
