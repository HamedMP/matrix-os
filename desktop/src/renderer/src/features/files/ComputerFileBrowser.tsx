import { FolderOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import {
  parseBrowserEntries,
  sortBrowserEntries,
  type BrowserEntry,
  type BrowserSortDirection,
  type BrowserSortKey,
} from "./browser-entries";
import { useBrowserViewPreference } from "./browser-view-preference";
import {
  BrowserToolbar,
  EntryButton,
  measureGridColumns,
  SortHeader,
} from "./browser-views";

type BrowserStatus = "loading" | "ready" | "error";

export type FolderPickerChoice =
  | { kind: "choose" }
  | { kind: "blocked"; message: string }
  | { kind: "alternate"; label: string; message: string };

const NO_ENTRIES: BrowserEntry[] = [];

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export default function ComputerFileBrowser({
  compact = false,
  framed = true,
  mode = "browse",
  onOpenFile,
  onChooseFolder,
  resolveFolderChoice,
  onAlternateFolderAction,
}: {
  compact?: boolean;
  // framed renders the browser as its own bordered card (dialogs, pickers).
  // The Files workspace passes framed={false} and wraps browser + preview in
  // a single bordered container with a hairline divider instead.
  framed?: boolean;
  // "folder-picker" lists directories only, so picking a target folder never
  // competes with files. The default "browse" mode is unchanged.
  mode?: "browse" | "folder-picker";
  onOpenFile?: (path: string) => void;
  onChooseFolder?: (path: string) => void;
  resolveFolderChoice?: (path: string) => FolderPickerChoice;
  onAlternateFolderAction?: (path: string) => void;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const view = useBrowserViewPreference((state) => state.view);
  const setView = useBrowserViewPreference((state) => state.setView);
  const [currentPath, setCurrentPath] = useState("");
  const [candidatePath, setCandidatePath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [status, setStatus] = useState<BrowserStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<BrowserSortKey>("name");
  const [sortDirection, setSortDirection] = useState<BrowserSortDirection>("asc");
  const requestGeneration = useRef(0);
  const entryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Navigating into a directory or switching between the grid and list
  // branches unmounts the focused row. Without restoring focus it falls to
  // <body>, arrow keys stop working, and a keyboard user is stranded outside
  // the listing with no way back in except the mouse.
  const restoreFocusRef = useRef(false);

  const markFocusForRestore = useCallback(() => {
    const active = document.activeElement;
    restoreFocusRef.current = entryRefs.current.some((el) => el !== null && el === active);
  }, []);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Listings belong to one computer/session. Derive the rendered view
  // synchronously from the scope they were loaded under, so a runtime switch
  // or replacement session never shows the previous owner's directory names or
  // lets stale rows fire onOpenFile/onChooseFolder against the new API.
  const browserScope = `${runtimeSlot}|${authGeneration}`;
  const [loadedScope, setLoadedScope] = useState(browserScope);
  const scoped = loadedScope === browserScope;
  const viewCurrentPath = scoped ? currentPath : "";
  const viewCandidatePath = scoped ? candidatePath : "";
  const viewSelectedPath = scoped ? selectedPath : null;
  const viewStatus: BrowserStatus = scoped ? status : "loading";
  const viewError = scoped ? error : null;
  const viewEntries = useMemo(
    () =>
      scoped
        ? mode === "folder-picker"
          ? entries.filter((entry) => entry.type === "directory")
          : entries
        : NO_ENTRIES,
    [scoped, mode, entries],
  );

  const sortedEntries = useMemo(
    () => sortBrowserEntries(viewEntries, sortKey, sortDirection),
    [viewEntries, sortKey, sortDirection],
  );

  const load = useCallback(async (path: string) => {
    if (!api) return;
    const generation = ++requestGeneration.current;
    setStatus("loading");
    setError(null);
    try {
      const response = await api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
      if (generation !== requestGeneration.current) return;
      setEntries(parseBrowserEntries(response.entries));
      setStatus("ready");
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setEntries([]);
      setStatus("error");
      setError(toUserMessage(err));
    }
  }, [api]);

  useEffect(() => {
    setLoadedScope(browserScope);
    setCurrentPath("");
    setCandidatePath("");
    setSelectedPath(null);
    void load("");
    return () => {
      requestGeneration.current += 1;
    };
  }, [browserScope, load]);

  const navigate = useCallback((path: string) => {
    markFocusForRestore();
    setCurrentPath(path);
    setCandidatePath(path);
    setSelectedPath(null);
    void load(path);
  }, [load, markFocusForRestore]);

  const goUp = useCallback(() => {
    if (viewCurrentPath) navigate(parentPath(viewCurrentPath));
  }, [navigate, viewCurrentPath]);

  // Single click selects; files also open their preview immediately so the
  // browser/preview split behaves like a Finder column with Quick Look.
  const selectEntry = useCallback((entry: BrowserEntry, path: string) => {
    setSelectedPath(path);
    if (entry.type === "directory") setCandidatePath(path);
    else onOpenFile?.(path);
  }, [onOpenFile]);

  // Double-click or Enter "opens": directories navigate, files preview.
  const activateEntry = useCallback((entry: BrowserEntry, path: string) => {
    if (entry.type === "directory") navigate(path);
    else onOpenFile?.(path);
  }, [navigate, onOpenFile]);

  // Grid and list render distinct entry branches, so a view switch remounts
  // every row; this restores focus once the new rows exist.
  useEffect(() => {
    if (viewStatus !== "ready" || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    entryRefs.current[0]?.focus();
  }, [viewStatus, sortedEntries, view]);

  const focusEntry = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, sortedEntries.length - 1));
    entryRefs.current[clamped]?.focus();
  }, [sortedEntries.length]);

  const onEntryKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, entry: BrowserEntry, path: string, index: number) => {
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      goUp();
      return;
    }
    const step = view === "grid" ? measureGridColumns(gridRef.current) : 1;
    switch (event.key) {
      case "Enter":
        // Prevent the native button click so activation fires exactly once.
        event.preventDefault();
        activateEntry(entry, path);
        break;
      case "Backspace":
        event.preventDefault();
        goUp();
        break;
      case "ArrowDown":
        event.preventDefault();
        focusEntry(index + step);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusEntry(index - step);
        break;
      case "ArrowRight":
        if (view === "grid") {
          event.preventDefault();
          focusEntry(index + 1);
        }
        break;
      case "ArrowLeft":
        if (view === "grid") {
          event.preventDefault();
          focusEntry(index - 1);
        }
        break;
    }
  }, [activateEntry, focusEntry, goUp, view]);

  const toggleSort = useCallback((key: BrowserSortKey) => {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  }, [sortKey]);

  const crumbs = useMemo(() => {
    const segments = viewCurrentPath ? viewCurrentPath.split("/") : [];
    return segments.map((label, index) => ({ label, path: segments.slice(0, index + 1).join("/") }));
  }, [viewCurrentPath]);

  const chosenName = (viewCandidatePath.split("/").pop() || "Matrix home");
  const folderChoice = viewCandidatePath
    ? resolveFolderChoice?.(viewCandidatePath) ?? { kind: "choose" as const }
    : null;
  // Name flexes (minmax(0,1fr) + truncate); Size/Modified are fixed-width
  // right-aligned columns sized to the format.ts outputs, so long names only
  // truncate once the pane is genuinely out of room.
  const listColumns = compact ? "minmax(0,1fr) 64px 88px" : "minmax(0,1fr) 72px 104px";

  let content: ReactNode;
  if (viewStatus === "loading") {
    content = (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading folder…</div>
    );
  } else if (viewStatus === "error") {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-sm" style={{ color: "var(--danger)" }}>{viewError}</span>
        <Button variant="subtle" onClick={() => void load(viewCurrentPath)}>Try again</Button>
      </div>
    );
  } else if (sortedEntries.length === 0) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm" style={{ color: "var(--text-tertiary)" }}>
        <FolderOpen size={22} aria-hidden />
        <span>{mode === "folder-picker" ? "No subfolders here." : "This folder is empty."}</span>
      </div>
    );
  } else {
    const buttons = sortedEntries.map((entry, index) => {
      const path = joinPath(viewCurrentPath, entry.name);
      const isCandidate = entry.type === "directory" && viewCandidatePath === path;
      return (
        <EntryButton
          key={`${entry.type}:${path}`}
          entry={entry}
          grid={view === "grid"}
          listColumns={listColumns}
          selected={viewSelectedPath === path || isCandidate}
          pressed={mode === "folder-picker" && entry.type === "directory" ? isCandidate : undefined}
          buttonRef={(el) => {
            entryRefs.current[index] = el;
          }}
          onSelect={() => selectEntry(entry, path)}
          onNavigate={() => {
            if (entry.type === "directory") navigate(path);
          }}
          onKeyDown={(event) => onEntryKeyDown(event, entry, path, index)}
        />
      );
    });
    content =
      view === "grid" ? (
        <div ref={gridRef} className="flex flex-wrap content-start gap-1">
          {buttons}
        </div>
      ) : (
        <div>
          <div
            className="sticky top-0 z-10 grid items-center gap-2 border-b px-2 pb-1 text-[11px] font-medium"
            style={{
              gridTemplateColumns: listColumns,
              borderColor: "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <SortHeader
              label="Name"
              sortLabel="Sort by name"
              active={sortKey === "name"}
              direction={sortDirection}
              onClick={() => toggleSort("name")}
            />
            <SortHeader
              label="Size"
              sortLabel="Sort by size"
              active={sortKey === "size"}
              direction={sortDirection}
              alignEnd
              onClick={() => toggleSort("size")}
            />
            <SortHeader
              label="Modified"
              sortLabel="Sort by modified"
              active={sortKey === "modified"}
              direction={sortDirection}
              alignEnd
              onClick={() => toggleSort("modified")}
            />
          </div>
          <div className="grid grid-cols-1 gap-0.5 pt-0.5">{buttons}</div>
        </div>
      );
  }

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden${framed ? " rounded-lg border" : ""}`}
      style={{ background: "var(--bg-surface)", borderColor: framed ? "var(--border-subtle)" : undefined }}
    >
      <BrowserToolbar
        compact={compact}
        currentPath={viewCurrentPath}
        crumbs={crumbs}
        view={view}
        onViewChange={(next) => {
          markFocusForRestore();
          setView(next);
        }}
        onUp={goUp}
        onNavigate={navigate}
        onRefresh={() => void load(viewCurrentPath)}
      />

      <div className={`${compact ? "h-52" : "min-h-0 flex-1"} overflow-y-auto p-1.5`}>{content}</div>

      {onChooseFolder ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
          <div className="min-w-0">
            <div className="truncate text-xs" style={{ color: "var(--text-secondary)" }} title={viewCandidatePath || "Matrix home"}>
              {viewCandidatePath || "Matrix home"}
            </div>
            {folderChoice && folderChoice.kind !== "choose" ? (
              <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                {folderChoice.message}
              </div>
            ) : null}
          </div>
          {folderChoice?.kind === "alternate" ? (
            <Button variant="primary" onClick={() => onAlternateFolderAction?.(viewCandidatePath)}>
              {folderChoice.label}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!viewCandidatePath || folderChoice?.kind === "blocked"}
              onClick={() => onChooseFolder(viewCandidatePath)}
            >
              Choose {chosenName}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
