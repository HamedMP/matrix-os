import { FolderOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import {
  parseBrowserEntries,
  isManagedBrowserPath,
  isProtectedFolderCreationParentPath,
  isProtectedFolderPickerPath,
  sortBrowserEntries,
  type BrowserEntry,
  type BrowserSortDirection,
  type BrowserSortKey,
} from "./browser-entries";
import { useBrowserHistory } from "./browser-history";
import { useBrowserViewPreference } from "./browser-view-preference";
import {
  BrowserToolbar,
  EntryButton,
  FolderPickerFooter,
  hasRegularDroppedFiles,
  measureGridColumns,
  regularDroppedFiles,
  SortHeader,
  UploadStatusList,
} from "./browser-views";
import { useFileUploads } from "./use-file-uploads";

type BrowserStatus = "loading" | "ready" | "error";

export type FolderPickerChoice =
  | { kind: "choose" }
  | { kind: "blocked"; message: string }
  | { kind: "alternate"; label: string; message: string };

export interface BrowserSelection {
  path: string;
  entry: BrowserEntry;
}

const NO_ENTRIES: BrowserEntry[] = [];
const DIRECTORY_PREVIEW_DELAY_MS = 500;

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
  onSelectionChange,
  onChooseFolder,
  onCreateFolder,
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
  onSelectionChange?: (selection: BrowserSelection | null) => void;
  onChooseFolder?: (path: string) => void;
  onCreateFolder?: (path: string) => void;
  resolveFolderChoice?: (path: string) => FolderPickerChoice;
  onAlternateFolderAction?: (path: string) => void;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const view = useBrowserViewPreference((state) => state.view);
  const setView = useBrowserViewPreference((state) => state.setView);
  const {
    currentPath,
    resetHistory,
    pushPath,
    moveBack,
    moveForward,
    canGoBack,
    canGoForward,
    backPath,
    forwardPath,
  } = useBrowserHistory();
  const [candidatePath, setCandidatePath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [status, setStatus] = useState<BrowserStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<BrowserSortKey>("name");
  const [sortDirection, setSortDirection] = useState<BrowserSortDirection>("asc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const requestGeneration = useRef(0);
  const directoryPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Navigating into a directory or switching between the grid and list
  // branches unmounts the focused row. Without restoring focus it falls to
  // <body>, arrow keys stop working, and a keyboard user is stranded outside
  // the listing with no way back in except the mouse.
  const restoreFocusRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const markFocusForRestore = useCallback(() => {
    const active = document.activeElement;
    restoreFocusRef.current = entryRefs.current.some((el) => el !== null && el === active);
  }, []);
  const cancelPendingDirectoryPreview = useCallback(() => {
    if (directoryPreviewTimer.current === null) return;
    clearTimeout(directoryPreviewTimer.current);
    directoryPreviewTimer.current = null;
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
  const viewReadOnly = isManagedBrowserPath(viewCurrentPath);
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

  const visibleEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return viewEntries;
    return viewEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery));
  }, [searchQuery, viewEntries]);
  const sortedEntries = useMemo(
    () => sortBrowserEntries(visibleEntries, sortKey, sortDirection),
    [visibleEntries, sortKey, sortDirection],
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

  const fileUploads = useFileUploads({
    api,
    browserScope,
    currentPath,
    enabled: mode === "browse",
    onUploaded: load,
  });

  const enqueueFiles = useCallback((files: File[], destination = viewCurrentPath) => {
    fileUploads.enqueue(files, destination);
  }, [fileUploads.enqueue, viewCurrentPath]);

  const onListingDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (mode !== "browse" || isManagedBrowserPath(viewCurrentPath) || !hasRegularDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    enqueueFiles(regularDroppedFiles(event.dataTransfer));
  }, [enqueueFiles, mode, viewCurrentPath]);

  const onListingPaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (mode !== "browse" || isManagedBrowserPath(viewCurrentPath)) return;
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    enqueueFiles(files);
  }, [enqueueFiles, mode, viewCurrentPath]);

  useEffect(() => {
    setLoadedScope(browserScope);
    resetHistory();
    setCandidatePath("");
    setSelectedPath(null);
    setSearchOpen(false);
    setSearchQuery("");
    void load("");
    return () => {
      cancelPendingDirectoryPreview();
      requestGeneration.current += 1;
    };
  }, [browserScope, cancelPendingDirectoryPreview, load, resetHistory]);

  const commitNavigation = useCallback((path: string, entry?: BrowserEntry) => {
    cancelPendingDirectoryPreview();
    markFocusForRestore();
    setCandidatePath(path);
    setSelectedPath(null);
    setSearchOpen(false);
    setSearchQuery("");
    onSelectionChange?.({
      path,
      entry: entry ?? {
        name: path ? path.split("/").pop() ?? path : "Matrix home",
        type: "directory",
      },
    });
    void load(path);
  }, [cancelPendingDirectoryPreview, load, markFocusForRestore, onSelectionChange]);

  const navigate = useCallback((path: string, entry?: BrowserEntry) => {
    pushPath(path);
    commitNavigation(path, entry);
  }, [commitNavigation, pushPath]);

  const goBack = useCallback(() => {
    if (backPath === null) return;
    moveBack();
    commitNavigation(backPath);
  }, [backPath, commitNavigation, moveBack]);

  const goForward = useCallback(() => {
    if (forwardPath === null) return;
    moveForward();
    commitNavigation(forwardPath);
  }, [commitNavigation, forwardPath, moveForward]);

  const goUp = useCallback(() => {
    if (viewCurrentPath) navigate(parentPath(viewCurrentPath));
  }, [navigate, viewCurrentPath]);

  // Single click selects; files also open their preview immediately so the
  // browser/preview split behaves like a Finder column with Quick Look.
  const selectEntry = useCallback((entry: BrowserEntry, path: string) => {
    setSelectedPath(path);
    cancelPendingDirectoryPreview();
    if (entry.type === "directory") {
      setCandidatePath(path);
      // Defer the overview-to-split reflow until the platform double-click
      // window closes. Otherwise the first click narrows the row before the
      // second click lands, so a native double-click can miss the folder.
      directoryPreviewTimer.current = setTimeout(() => {
        directoryPreviewTimer.current = null;
        onSelectionChange?.({ path, entry });
      }, DIRECTORY_PREVIEW_DELAY_MS);
    } else {
      onSelectionChange?.({ path, entry });
      onOpenFile?.(path);
    }
  }, [cancelPendingDirectoryPreview, onOpenFile, onSelectionChange]);

  // Double-click or Enter "opens": directories navigate, files preview.
  const activateEntry = useCallback((entry: BrowserEntry, path: string) => {
    if (entry.type === "directory") navigate(path, entry);
    else onOpenFile?.(path);
  }, [navigate, onOpenFile]);

  // Grid and list render distinct entry branches, so a view switch remounts
  // every row; this restores focus once the new rows exist.
  useEffect(() => {
    if (viewStatus !== "ready" || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    entryRefs.current[0]?.focus();
  }, [viewStatus, sortedEntries, view, searchOpen]);

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
  const resolvedFolderChoice = viewCandidatePath
    ? resolveFolderChoice?.(viewCandidatePath) ?? { kind: "choose" as const }
    : null;
  const folderChoice = viewCandidatePath
    ? isProtectedFolderPickerPath(viewCandidatePath)
      ? {
          kind: "blocked" as const,
          message: "This folder is protected by Matrix OS and can't be used as a workspace.",
        }
      : resolvedFolderChoice
    : null;
  // Name flexes (minmax(0,1fr) + truncate); Size/Modified are fixed-width
  // right-aligned columns sized to the format.ts outputs, so long names only
  // truncate once the pane is genuinely out of room.
  const listColumns = compact ? "minmax(0,1fr) 56px 80px" : "minmax(0,1fr) 110px 110px";

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
        <span>{searchQuery.trim() ? "No files match this search." : mode === "folder-picker" ? "No subfolders here." : "This folder is empty."}</span>
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
          compact={compact}
          selected={viewSelectedPath === path || isCandidate}
          pressed={mode === "folder-picker" && entry.type === "directory" ? isCandidate : undefined}
          managed={isManagedBrowserPath(path)}
          buttonRef={(el) => {
            entryRefs.current[index] = el;
          }}
          onSelect={() => selectEntry(entry, path)}
          onNavigate={() => {
            if (entry.type === "directory") navigate(path, entry);
          }}
          onKeyDown={(event) => onEntryKeyDown(event, entry, path, index)}
          onDropFiles={mode === "browse" && entry.type === "directory" && !isManagedBrowserPath(path)
            ? (files) => enqueueFiles(files, path)
            : undefined}
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
            data-files-list-header
            className={`sticky top-0 z-10 grid items-center border-b px-2 font-medium ${compact ? "gap-1 pb-1 text-[11px]" : "h-9 gap-4 text-sm"}`}
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
              label={compact ? "Modified" : "Date modified"}
              sortLabel="Sort by modified"
              active={sortKey === "modified"}
              direction={sortDirection}
              alignEnd
              onClick={() => toggleSort("modified")}
            />
          </div>
          <div className={`grid grid-cols-1 ${compact ? "gap-0.5 pt-0.5" : "gap-0"}`}>{buttons}</div>
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
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={goBack}
        onForward={goForward}
        readOnly={viewReadOnly}
        onNavigate={navigate}
        onRefresh={() => void load(viewCurrentPath)}
        onUpload={mode === "browse" && !viewReadOnly ? () => fileInputRef.current?.click() : undefined}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        onSearchOpen={() => setSearchOpen(true)}
        onSearchClose={() => {
          restoreFocusRef.current = sortedEntries.length > 0;
          setSearchOpen(false);
          setSearchQuery("");
        }}
        onSearchQueryChange={setSearchQuery}
      />

      {mode === "browse" ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Choose files to upload"
          onChange={(event) => {
            enqueueFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
      ) : null}
      <div
        data-files-listing
        className={`${compact ? "h-52" : "min-h-0 flex-1"} relative overflow-y-auto ${
          compact && view === "list" ? "px-1.5 pb-1.5" : compact || view === "grid" ? "p-1.5" : "pb-4"
        }`}
        onDragEnter={mode === "browse" && !viewReadOnly ? (event) => {
          if (!hasRegularDroppedFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragActive(true);
        } : undefined}
        onDragLeave={mode === "browse" && !viewReadOnly ? () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragActive(false);
        } : undefined}
        onDragOver={mode === "browse" && !viewReadOnly ? (event) => {
          if (hasRegularDroppedFiles(event.dataTransfer)) event.preventDefault();
        } : undefined}
        onDrop={mode === "browse" && !viewReadOnly ? onListingDrop : undefined}
        onPaste={mode === "browse" && !viewReadOnly ? onListingPaste : undefined}
      >
        {content}
        {dragActive ? (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border border-dashed text-sm" style={{ borderColor: "var(--accent)", color: "var(--accent)", background: "var(--bg-surface)" }}>
            Drop files to upload
          </div>
        ) : null}
      </div>

      <UploadStatusList uploads={fileUploads.uploads} onRetry={fileUploads.retry} onRemove={fileUploads.remove} />

      {onChooseFolder ? (
        <FolderPickerFooter
          path={viewCandidatePath}
          message={folderChoice && folderChoice.kind !== "choose" ? folderChoice.message : undefined}
          actionLabel={folderChoice?.kind === "alternate" ? folderChoice.label : `Choose ${chosenName}`}
          disabled={folderChoice?.kind === "alternate" ? false : !viewCandidatePath || folderChoice?.kind === "blocked"}
          onCreateFolder={onCreateFolder && resolvedFolderChoice?.kind === "choose" && !isProtectedFolderCreationParentPath(viewCandidatePath)
            ? () => onCreateFolder(viewCandidatePath)
            : undefined}
          onAction={() => folderChoice?.kind === "alternate"
            ? onAlternateFolderAction?.(viewCandidatePath)
            : onChooseFolder(viewCandidatePath)}
        />
      ) : null}
    </div>
  );
}
