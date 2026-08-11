import { ArrowUp, ChevronRight, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { diagnosticErrorKind } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { parseBrowserEntries, type BrowserEntry } from "./browser-entries";
import { createFileManagementApi } from "./file-management-api";
import { isValidFileDropTarget } from "./file-drag";
import type { FileMoveSession } from "./use-file-move";

const NO_DIRECTORIES: BrowserEntry[] = [];
const IGNORE_CLOSE = () => {};
const INVALID_MOVE_REASON = {
  source_missing: "This item is no longer available.",
  protected: "This item is protected and cannot be moved.",
  invalid_destination: "This item cannot be moved to that destination.",
} as const;

interface MoveDialogControls {
  session: FileMoveSession | null;
  cancelMove: () => void;
  chooseCandidate: (destination: string) => void;
  chooseDestination: (destination: string) => void;
  setApplyToRemaining: (apply: boolean) => void;
  chooseConflict: (source: string, resolution: "keep-both" | "skip") => void;
  confirmMove: () => void;
}

export function MoveFilesDialog({ controls }: { controls: MoveDialogControls }) {
  if (!controls.session) return null;
  return <ActiveMoveFilesDialog controls={{ ...controls, session: controls.session }} />;
}

function ActiveMoveFilesDialog({
  controls,
}: {
  controls: MoveDialogControls & { session: FileMoveSession };
}) {
  const {
    session,
    cancelMove: onCancel,
    chooseCandidate: onChooseCandidate,
    chooseDestination: onMove,
    setApplyToRemaining: onApplyToRemaining,
    chooseConflict: onChooseConflict,
    confirmMove: onConfirm,
  } = controls;
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [directory, setDirectory] = useState("");
  const [directories, setDirectories] = useState<BrowserEntry[]>(NO_DIRECTORIES);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadGeneration = useRef(0);
  const requestedDirectory = useRef("");
  const picking = session?.stage === "picking";
  const fileApi = useMemo(() => api ? createFileManagementApi(api) : null, [api]);

  const load = useCallback(async (nextDirectory: string) => {
    if (!fileApi || !picking) return;
    const generation = ++loadGeneration.current;
    requestedDirectory.current = nextDirectory;
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fileApi.list(nextDirectory);
      if (generation !== loadGeneration.current) return;
      setDirectories(parseBrowserEntries(response.entries).filter((entry) => entry.type === "directory"));
      setDirectory(nextDirectory);
    } catch (error: unknown) {
      if (generation !== loadGeneration.current) return;
      console.warn("[move-files-dialog] folder listing failed:", diagnosticErrorKind(error));
      setDirectories(NO_DIRECTORIES);
      setLoadError(true);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [fileApi, picking]);

  useEffect(() => {
    loadGeneration.current += 1;
    setDirectory("");
    setDirectories(NO_DIRECTORIES);
    setLoadError(false);
    if (picking) void load("");
    return () => { loadGeneration.current += 1; };
  }, [api, runtimeSlot, authGeneration, picking, session?.sources, load]);

  if (session.stage === "resolving") {
    const complete = session.choices.every((choice) => choice.resolution !== null);
    return (
      <Dialog open onClose={onCancel} width={520}>
        <div className="flex max-h-[64vh] flex-col gap-3 p-4">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Resolve move conflicts</h2>
          <div className="min-h-0 space-y-2 overflow-y-auto">
            {session.preflight?.invalid.map((item) => (
              <div key={item.source} className="rounded-md border p-2" style={{ borderColor: "var(--border-subtle)" }}>
                <span data-testid="move-invalid-source" className="block truncate text-sm">{item.source}</span>
                <span className="block text-xs" style={{ color: "var(--text-secondary)" }}>
                  {INVALID_MOVE_REASON[item.code]}
                </span>
              </div>
            ))}
            {session.choices.map((choice) => (
              <div key={choice.source} className="flex items-center justify-between gap-3 rounded-md border p-2" style={{ borderColor: "var(--border-subtle)" }}>
                <span data-testid="move-conflict-source" className="min-w-0 truncate text-sm">{choice.source}</span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant={choice.resolution === "keep-both" ? "primary" : "subtle"}
                    aria-label={`Keep Both for ${choice.source}`}
                    aria-pressed={choice.resolution === "keep-both"}
                    onClick={() => onChooseConflict(choice.source, "keep-both")}
                  >Keep Both</Button>
                  <Button
                    variant={choice.resolution === "skip" ? "primary" : "subtle"}
                    aria-label={`Skip ${choice.source}`}
                    aria-pressed={choice.resolution === "skip"}
                    onClick={() => onChooseConflict(choice.source, "skip")}
                  >Skip</Button>
                </div>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={session.applyToRemaining}
              onChange={(event) => onApplyToRemaining(event.currentTarget.checked)}
            />
            Apply to remaining conflicts
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" aria-label="Cancel move" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={!complete} onClick={onConfirm}>Move selected items</Button>
          </div>
        </div>
      </Dialog>
    );
  }
  if (!picking) {
    return (
      <Dialog open onClose={session.stage === "executing" ? IGNORE_CLOSE : onCancel} width={360}>
        <div className="p-4 text-sm" role="status">Preparing move…</div>
      </Dialog>
    );
  }
  const candidate = session.destination;
  const scope = { directory: parentDirectory(session.sources[0]!), runtimeSlot, authGeneration };
  const candidateValid = candidate !== null && isValidFileDropTarget({
    version: 1,
    paths: session.sources,
    scope,
  }, candidate);
  const candidateInvalid = candidate !== null && !candidateValid;
  const crumbs = directory ? directory.split("/").map((label, index, segments) => ({
    label,
    path: segments.slice(0, index + 1).join("/"),
  })) : [];

  return (
    <Dialog open onClose={onCancel} width={520}>
      <div className="flex max-h-[64vh] flex-col">
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Move {session.sources.length === 1 ? "1 item" : `${session.sources.length} items`}
          </h2>
        </div>
        <div className="flex items-center gap-1 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
          <Button variant="ghost" aria-label="Up one level" disabled={!directory} onClick={() => void load(parentDirectory(directory))}>
            <ArrowUp size={13} aria-hidden />Up
          </Button>
          <button type="button" className="rounded px-2 py-1 text-xs" onClick={() => void load("")}>Matrix home</button>
          {crumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <ChevronRight size={11} aria-hidden />
              <button type="button" className="rounded px-1.5 py-1 text-xs" onClick={() => void load(crumb.path)}>{crumb.label}</button>
            </span>
          ))}
        </div>
        <div className="min-h-40 overflow-y-auto p-2">
          {loading ? <p className="p-2 text-xs">Loading folders…</p> : loadError ? (
            <div className="flex flex-col items-center gap-2 p-3 text-xs">
              <span role="alert">Folders could not be loaded.</span>
              <Button variant="subtle" aria-label="Retry folders" onClick={() => void load(requestedDirectory.current)}>Retry</Button>
            </div>
          ) : directories.length === 0 ? (
            <p className="p-2 text-xs" style={{ color: "var(--text-tertiary)" }}>No subfolders here.</p>
          ) : directories.map((entry) => {
            const path = joinPath(directory, entry.name);
            return (
              <button
                key={path}
                type="button"
                aria-label={`Choose ${entry.name}`}
                aria-pressed={candidate === path}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm"
                style={{ background: candidate === path ? "var(--bg-selected)" : "transparent" }}
                onClick={() => onChooseCandidate(path)}
                onDoubleClick={() => void load(path)}
              >
                <Folder size={16} aria-hidden />{entry.name}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="min-w-0">
            <span className="block truncate text-xs" style={{ color: "var(--text-secondary)" }}>{candidate ?? "Choose a destination folder"}</span>
            {candidateInvalid ? (
              <span role="alert" className="block text-xs" style={{ color: "var(--danger)" }}>
                Choose a folder outside the selected folder.
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" aria-label="Cancel move" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={!candidateValid} onClick={() => candidate && onMove(candidate)}>Move</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
