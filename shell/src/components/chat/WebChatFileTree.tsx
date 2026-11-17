"use client";
import { useEffect, useState } from "react";
import { ChevronRight, FileCode2, Folder, FolderOpen, Search } from "lucide-react";
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
}: {
  gatewayUrl: string;
  path: string;
  depth: number;
  expanded: readonly string[];
  toggle(path: string): void;
  query: string;
  onOpenFile(path: string): void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [truncated, setTruncated] = useState(false);
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
        setEntries(
          all
            .slice(0, 1000)
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)),
        );
        setTruncated(all.length > 1000);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("[chat-inspector] Files unavailable:", cause instanceof Error ? cause.name : "UnknownError");
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [gatewayUrl, path, retry]);
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
      {truncated ? <p className="px-3 text-xs text-muted-foreground">Showing the first 1,000 files.</p> : null}
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
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-3 text-left text-xs hover:bg-accent"
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
  onOpenFile,
}: {
  gatewayUrl: string;
  rootPath?: string;
  onOpenFile(path: string): void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const toggle = (path: string) =>
    setExpanded((current) =>
      current.includes(path)
        ? current.filter((value) => value !== path && !value.startsWith(path + "/"))
        : [...current.slice(-19), path],
    );
  return (
    <>
      <label className="m-3 flex h-8 shrink-0 items-center gap-2 rounded-md border px-2 text-xs text-muted-foreground">
        <Search size={14} aria-hidden />
        <input
          aria-label="Filter files"
          placeholder="Filter files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <FileBranch
          key={rootPath}
          gatewayUrl={gatewayUrl}
          path={rootPath}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          query={query}
          onOpenFile={onOpenFile}
        />
      </div>
    </>
  );
}

export function WebChatFileTree({
  gatewayUrl,
  project,
  onOpenFile,
}: {
  gatewayUrl: string;
  project?: { id: string; slug: string };
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
  if (!project) return <FileTree gatewayUrl={gatewayUrl} onOpenFile={onOpenFile} />;
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
  return <FileTree gatewayUrl={gatewayUrl} rootPath={root} onOpenFile={onOpenFile} />;
}
