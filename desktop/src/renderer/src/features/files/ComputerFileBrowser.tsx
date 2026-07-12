import {
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Home,
  Image as ImageIcon,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { parseEntries, type FileEntry } from "../../stores/file-tree";

type BrowserStatus = "loading" | "ready" | "error";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return <ImageIcon size={16} />;
  if (/\.(tsx?|jsx?|json|css|html|py|rs|go|mdx?)$/i.test(name)) return <FileCode2 size={16} />;
  return <File size={16} />;
}

export default function ComputerFileBrowser({
  compact = false,
  onOpenFile,
  onChooseFolder,
}: {
  compact?: boolean;
  onOpenFile?: (path: string) => void;
  onChooseFolder?: (path: string) => void;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const [currentPath, setCurrentPath] = useState("");
  const [candidatePath, setCandidatePath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<BrowserStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async (path: string) => {
    if (!api) return;
    const generation = ++requestGeneration.current;
    setStatus("loading");
    setError(null);
    try {
      const response = await api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
      if (generation !== requestGeneration.current) return;
      setEntries(parseEntries(response.entries));
      setStatus("ready");
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setEntries([]);
      setStatus("error");
      setError(toUserMessage(err));
    }
  }, [api]);

  useEffect(() => {
    setCurrentPath("");
    setCandidatePath("");
    void load("");
    return () => {
      requestGeneration.current += 1;
    };
  }, [load, runtimeSlot]);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
    setCandidatePath(path);
    void load(path);
  }, [load]);

  const crumbs = useMemo(() => {
    const segments = currentPath ? currentPath.split("/") : [];
    return segments.map((label, index) => ({ label, path: segments.slice(0, index + 1).join("/") }));
  }, [currentPath]);

  const chosenName = (candidatePath.split("/").pop() || "Matrix home");

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--border-subtle)" }}>
        <button
          type="button"
          aria-label="Matrix home"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
          style={{ color: currentPath ? "var(--text-secondary)" : "var(--text-primary)" }}
          onClick={() => navigate("")}
        >
          <Home size={13} />
          {!compact ? "Matrix home" : "Home"}
        </button>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="flex min-w-0 items-center gap-1">
            <ChevronRight size={11} style={{ color: "var(--text-tertiary)" }} />
            <button
              type="button"
              className="max-w-[150px] truncate rounded px-1.5 py-1 text-xs hover:bg-[var(--bg-hover)]"
              style={{ color: crumb.path === currentPath ? "var(--text-primary)" : "var(--text-secondary)" }}
              onClick={() => navigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <span className="ml-auto">
          <IconButton label="Refresh folder" onClick={() => void load(currentPath)}>
            <RefreshCw size={13} />
          </IconButton>
        </span>
      </div>

      <div className={`${compact ? "h-52" : "min-h-0 flex-1"} overflow-y-auto p-1.5`}>
        {status === "loading" ? (
          <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading folder…</div>
        ) : status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="text-sm" style={{ color: "var(--danger)" }}>{error}</span>
            <Button variant="subtle" onClick={() => void load(currentPath)}>Try again</Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>This folder is empty.</div>
        ) : (
          <div className="grid grid-cols-1 gap-0.5">
            {entries.map((entry) => {
              const path = joinPath(currentPath, entry.name);
              const selected = entry.type === "directory" && candidatePath === path;
              return (
                <button
                  key={`${entry.type}:${path}`}
                  type="button"
                  aria-label={`Open ${entry.name}`}
                  aria-pressed={entry.type === "directory" ? selected : undefined}
                  className="group flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
                  style={{
                    background: selected ? "var(--bg-selected)" : "transparent",
                    color: "var(--text-primary)",
                  }}
                  onClick={() => {
                    if (entry.type === "directory") setCandidatePath(path);
                    else onOpenFile?.(path);
                  }}
                  onDoubleClick={() => {
                    if (entry.type === "directory") navigate(path);
                  }}
                >
                  <span style={{ color: entry.type === "directory" ? "var(--accent)" : "var(--text-tertiary)" }}>
                    {entry.type === "directory" ? (selected ? <FolderOpen size={17} /> : <Folder size={17} />) : fileIcon(entry.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.type === "directory" ? <ChevronRight size={13} className="opacity-0 group-hover:opacity-100" style={{ color: "var(--text-tertiary)" }} /> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {onChooseFolder ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
          <span className="min-w-0 truncate text-xs" style={{ color: "var(--text-secondary)" }} title={candidatePath || "Matrix home"}>
            {candidatePath || "Matrix home"}
          </span>
          <Button variant="primary" disabled={!candidatePath} onClick={() => onChooseFolder(candidatePath)}>
            Choose {chosenName}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
