import type { FileBrowseResponse, FileReadResponse } from "@matrix-os/contracts";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../../stores/connection";
import { invoke } from "../../lib/operator";
import ComputerFileBrowser from "../files/ComputerFileBrowser";
import { parseBrowserEntries } from "../files/browser-entries";
import { FilePreview, resolveActivePath, type FileSelection } from "../files/FilePreviewPane";
import type { WorkFilesScope } from "../work/work-files-scope";
import { ArrowUp, ChevronDown, ChevronRight, Folder } from "@renderer/lib/hugeicons";
import { FileTypeIcon } from "../files/FileTypeIcon";
import { MonacoReadOnlyEditor } from "../editor/MonacoReadOnlyEditor";

export type InspectorFileTarget =
  | { kind: "home"; path: string; label: string }
  | {
      kind: "project";
      path: string;
      label: string;
      projectId: string;
      worktreeId?: string;
    };

type InspectorTreeEntry = { path: string; kind: "file" | "directory" };
type InspectorTreeDirectory = {
  status: "loading" | "ready" | "error";
  entries: InspectorTreeEntry[];
};

const MAX_EXPANDED_FILE_DIRECTORIES = 200;

function joinInspectorPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function ExpandableFileTree({
  loadDirectory,
  onOpenFile,
}: {
  loadDirectory: (path: string) => Promise<InspectorTreeEntry[]>;
  onOpenFile: (path: string) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [directories, setDirectories] = useState<Record<string, InspectorTreeDirectory>>({});
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const ensureDirectory = useCallback((path: string) => {
    setDirectories((current) => {
      if (current[path] || Object.keys(current).length >= MAX_EXPANDED_FILE_DIRECTORIES) return current;
      return { ...current, [path]: { status: "loading", entries: [] } };
    });
    void loadDirectory(path).then((entries) => {
      if (!mounted.current) return;
      setDirectories((current) => ({ ...current, [path]: { status: "ready", entries } }));
    }).catch(() => {
      if (!mounted.current) return;
      setDirectories((current) => ({ ...current, [path]: { status: "error", entries: [] } }));
    });
  }, [loadDirectory]);

  useEffect(() => { ensureDirectory(""); }, [ensureDirectory]);

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
            aria-label={entry.kind === "directory"
              ? `${expanded ? "Collapse" : "Expand"} folder ${entry.path}`
              : `Open file ${entry.path}`}
            {...(entry.kind === "directory" ? { "aria-expanded": expanded } : {})}
            className="flex w-full items-center gap-2 truncate py-2 pr-3 text-left text-xs outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            style={{ paddingLeft: 12 + depth * 16, color: "var(--text-primary)" }}
            onClick={() => entry.kind === "directory" ? toggleDirectory(entry.path) : onOpenFile(entry.path)}
          >
            {entry.kind === "directory" ? (
              <>
                {expanded ? <ChevronDown size={13} aria-hidden className="shrink-0" /> : <ChevronRight size={13} aria-hidden className="shrink-0" />}
                <Folder size={16} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
              </>
            ) : <FileTypeIcon filename={entry.path.split("/").at(-1) ?? entry.path} />}
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

/**
 * Inspector Files surface: the shared computer file browser in compact mode,
 * optionally without an inline preview so a parent tab workspace can render
 * browser and preview side by side. Selection is scoped to the current
 * computer/session so a runtime switch can never preview another owner's path.
 */
export function InspectorFilesPanel({
  scopeLabel = "Matrix Home",
  scope = { kind: "home", chatId: "legacy-inspector" },
  browserOnly = false,
  forceList = false,
  onOpenFile,
}: {
  scopeLabel?: string;
  scope?: WorkFilesScope;
  browserOnly?: boolean;
  forceList?: boolean;
  onOpenFile?: (target: InspectorFileTarget) => void;
}) {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);

  if (scope.kind === "unavailable") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
        Files are unavailable for this chat.
      </div>
    );
  }
  const scopeKey = `${scope.chatId}:${runtimeSlot}:${authGeneration}`;
  if (scope.kind === "project") {
    return (
      <ProjectFilesPanel
        key={`${scopeKey}:${scope.projectId}:${scope.worktreeId ?? "root"}`}
        scope={scope}
        browserOnly={browserOnly}
        onOpenFile={onOpenFile}
      />
    );
  }
  return (
    <HomeFilesPanel
      key={scopeKey}
      scopeLabel={scopeLabel}
      browserOnly={browserOnly}
      forceList={forceList}
      onOpenFile={onOpenFile}
    />
  );
}

function HomeFilesPanel({
  scopeLabel,
  browserOnly,
  forceList,
  onOpenFile,
}: {
  scopeLabel: string;
  browserOnly: boolean;
  forceList: boolean;
  onOpenFile?: (target: InspectorFileTarget) => void;
}) {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const api = useConnection((state) => state.api);
  const [selection, setSelection] = useState<FileSelection | null>(null);

  const activePath = resolveActivePath(selection, runtimeSlot, authGeneration);

  useEffect(() => {
    setSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
  }, [runtimeSlot, authGeneration]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (onOpenFile) {
        onOpenFile({ kind: "home", path, label: path.split("/").at(-1) ?? path });
        return;
      }
      setSelection({ slot: runtimeSlot, authGeneration, path });
    },
    [runtimeSlot, authGeneration, onOpenFile],
  );
  const loadDirectory = useCallback(async (path: string): Promise<InspectorTreeEntry[]> => {
    if (!api) throw new Error("FilesUnavailable");
    const response = await api.get<{ entries?: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
    return parseBrowserEntries(response.entries).map((entry) => ({
      path: joinInspectorPath(path, entry.name),
      kind: entry.type,
    }));
  }, [api]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="shrink-0 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{scopeLabel}</p>
        <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          Browse this computer&apos;s files. This view is not limited to the selected project.
        </p>
      </div>
      {browserOnly ? (
        <ExpandableFileTree loadDirectory={loadDirectory} onOpenFile={handleOpenFile} />
      ) : (
        <div className="shrink-0">
          <ComputerFileBrowser compact framed forceList={forceList} onOpenFile={handleOpenFile} />
        </div>
      )}
      {!browserOnly ? <section
        aria-label="File preview"
        className="flex min-h-[180px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <div
          className="flex h-8 shrink-0 items-center border-b px-2.5 text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          <span className="truncate" title={activePath ?? undefined}>{activePath ?? "Preview"}</span>
        </div>
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>
              Loading preview…
            </div>
          }
        >
          <FilePreview path={activePath} />
        </Suspense>
      </section> : null}
    </div>
  );
}

function ProjectFilesPanel({
  scope,
  browserOnly,
  onOpenFile,
}: {
  scope: Extract<WorkFilesScope, { kind: "project" }>;
  browserOnly: boolean;
  onOpenFile?: (target: InspectorFileTarget) => void;
}) {
  if (browserOnly) {
    return <ProjectFilesTree scope={scope} onOpenFile={onOpenFile} />;
  }
  return <ProjectNavigableFilesPanel scope={scope} onOpenFile={onOpenFile} />;
}

function ProjectFilesTree({
  scope,
  onOpenFile,
}: {
  scope: Extract<WorkFilesScope, { kind: "project" }>;
  onOpenFile?: (target: InspectorFileTarget) => void;
}) {
  const loadDirectory = useCallback(async (path: string): Promise<InspectorTreeEntry[]> => {
    const response = await invoke("runtime:browse-files", {
      projectId: scope.projectId,
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
      ...(path ? { path } : {}),
      limit: 50,
    });
    return response.entries.items.flatMap((entry) => (
      entry.kind === "file" || entry.kind === "directory"
        ? [{ path: entry.path, kind: entry.kind }]
        : []
    ));
  }, [scope.projectId, scope.worktreeId]);
  const openFile = useCallback((path: string) => {
    onOpenFile?.({
      kind: "project",
      path,
      label: path.split("/").at(-1) ?? path,
      projectId: scope.projectId,
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
    });
  }, [onOpenFile, scope.projectId, scope.worktreeId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
          {scope.label}{scope.worktreeId ? " worktree" : ""}
        </p>
        <p className="truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>Project root</p>
      </div>
      <ExpandableFileTree loadDirectory={loadDirectory} onOpenFile={openFile} />
    </div>
  );
}

function ProjectNavigableFilesPanel({
  scope,
  onOpenFile,
}: {
  scope: Extract<WorkFilesScope, { kind: "project" }>;
  onOpenFile?: (target: InspectorFileTarget) => void;
}) {
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<FileBrowseResponse | null>(null);
  const [file, setFile] = useState<FileReadResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const browseSequence = useRef(0);
  const readSequence = useRef(0);

  useEffect(() => {
    const sequence = ++browseSequence.current;
    readSequence.current += 1;
    setStatus("loading");
    setListing(null);
    setFile(null);
    void invoke("runtime:browse-files", {
      projectId: scope.projectId,
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
      ...(path ? { path } : {}),
      limit: 50,
    }).then((response) => {
      if (browseSequence.current !== sequence) return;
      setListing(response);
      setStatus("ready");
    }).catch(() => {
      if (browseSequence.current !== sequence) return;
      setStatus("error");
    });
    return () => { browseSequence.current += 1; };
  }, [path, scope.projectId, scope.worktreeId]);

  const openFile = (filePath: string) => {
    if (onOpenFile) {
      onOpenFile({
        kind: "project",
        path: filePath,
        label: filePath.split("/").at(-1) ?? filePath,
        projectId: scope.projectId,
        ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
      });
      return;
    }
    const sequence = ++readSequence.current;
    setFile(null);
    void invoke("runtime:get-file-content", {
      projectId: scope.projectId,
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
      path: filePath,
    }).then((response) => {
      if (readSequence.current === sequence) setFile(response);
    }).catch(() => {
      if (readSequence.current === sequence) setFile(null);
    });
  };

  const parentPath = path?.split("/").slice(0, -1).join("/") || undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
          {scope.label}{scope.worktreeId ? " worktree" : ""}
        </p>
        <p className="truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>{path ?? "Project root"}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="files-listing" style={{ background: "var(--bg-surface)" }}>
        {path ? (
          <button
            type="button"
            aria-label="Go to parent folder"
            className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
            style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
            onClick={() => setPath(parentPath)}
          >
            <ArrowUp size={14} aria-hidden />
            Parent folder
          </button>
        ) : null}
        {status === "loading" ? <p className="p-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading files…</p> : null}
        {status === "error" ? <p className="p-3 text-xs" style={{ color: "var(--danger)" }}>Files are unavailable.</p> : null}
        {listing?.entries.items.map((entry) => (
          <button
            key={entry.path}
            type="button"
            aria-label={entry.kind === "directory" ? `Open folder ${entry.path}` : `Open file ${entry.path}`}
            className="flex w-full items-center gap-2 truncate px-3 py-2 text-left text-xs hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-primary)" }}
            onClick={() => entry.kind === "directory" ? setPath(entry.path) : openFile(entry.path)}
          >
            {entry.kind === "directory" ? (
              <>
                <ChevronRight size={13} aria-hidden className="shrink-0" />
                <Folder size={16} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
              </>
            ) : <FileTypeIcon filename={entry.path.split("/").at(-1) ?? entry.path} />}
            <span className="truncate">{entry.path.split("/").at(-1)}</span>
          </button>
        ))}
        {status === "ready" && listing?.entries.items.length === 0 ? (
          <p className="p-3 text-xs" style={{ color: "var(--text-tertiary)" }}>No files.</p>
        ) : null}
      </div>
      <section aria-label="File preview" className="min-h-[160px] overflow-auto rounded-md border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        {file ? (
          <>
            <p className="mb-2 truncate text-xs" style={{ color: "var(--text-secondary)" }}>{file.metadata.path}</p>
            <pre className="whitespace-pre-wrap break-words text-xs" style={{ color: "var(--text-primary)" }}>{file.content}</pre>
            {file.truncated ? <p className="mt-2 text-xs" style={{ color: "var(--text-tertiary)" }}>Preview truncated.</p> : null}
          </>
        ) : <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Choose a file</p>}
      </section>
    </div>
  );
}

export function InspectorFilePreview({ target }: { target: InspectorFileTarget }) {
  if (target.kind === "home") {
    return (
      <Suspense
        fallback={<div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>}
      >
        <FilePreview path={target.path} textRenderer="monaco" />
      </Suspense>
    );
  }
  return <ProjectFilePreview target={target} />;
}

function ProjectFilePreview({
  target,
}: {
  target: Extract<InspectorFileTarget, { kind: "project" }>;
}) {
  const [file, setFile] = useState<FileReadResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let current = true;
    setFile(null);
    setStatus("loading");
    void invoke("runtime:get-file-content", {
      projectId: target.projectId,
      ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
      path: target.path,
    }).then((response) => {
      if (!current) return;
      setFile(response);
      setStatus("ready");
    }).catch(() => {
      if (current) setStatus("error");
    });
    return () => { current = false; };
  }, [target.path, target.projectId, target.worktreeId]);

  if (status === "loading") {
    return <p className="p-4 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</p>;
  }
  if (status === "error" || !file) {
    return <p className="p-4 text-xs" style={{ color: "var(--danger)" }}>Preview unavailable.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MonacoReadOnlyEditor path={target.path} content={file.content} />
      {file.truncated ? <p className="shrink-0 border-t px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>Preview truncated.</p> : null}
    </div>
  );
}
