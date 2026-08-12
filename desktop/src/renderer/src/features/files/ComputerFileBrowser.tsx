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
import { diagnosticErrorKind } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import {
  parseBrowserEntries,
  sortBrowserEntries,
  type BrowserEntry,
  type BrowserSortDirection,
  type BrowserSortKey,
} from "./browser-entries";
import { useBrowserViewPreference } from "./browser-view-preference";
import { InlineNameEditor } from "./InlineNameEditor";
import { FileCreationContextMenu, ManagedFileActionMenu } from "./FileActionMenu";
import { FileOperationNotice, MoveToTrashDialog } from "./FileOperationNotice";
import {
  BrowserToolbar,
  BrowserListing,
  EntryButton,
  getFileListColumns,
  measureGridColumns,
} from "./browser-views";
import { useFileManagement } from "./use-file-management";
import { useAuthoritativeListing, type BrowserListingStatus } from "./use-authoritative-listing";
import { MAX_FILE_BATCH_SIZE, type FileSelectionPlatform } from "./file-selection";
import { getKernelSocket } from "../../lib/kernel-wiring";
import type { DirectorySyncSocket } from "./use-directory-sync";

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
  onPreviewPathChange,
  onChooseFolder,
  onOpenInEditor,
  directorySocket = getKernelSocket(),
  selectionPlatform = defaultSelectionPlatform(),
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
  onPreviewPathChange?: (path: string | null) => void;
  onChooseFolder?: (path: string) => void;
  onOpenInEditor?: (path: string) => void;
  directorySocket?: DirectorySyncSocket | null;
  selectionPlatform?: FileSelectionPlatform;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const view = useBrowserViewPreference((state) => state.view);
  const setView = useBrowserViewPreference((state) => state.setView);
  const [currentPath, setCurrentPath] = useState("");
  const [candidatePath, setCandidatePath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<BrowserSortKey>("name");
  const [sortDirection, setSortDirection] = useState<BrowserSortDirection>("asc");
  const entryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Navigating into a directory or switching between the grid and list
  // branches unmounts the focused row. Without restoring focus it falls to
  // <body>, arrow keys stop working, and a keyboard user is stranded outside
  // the listing with no way back in except the mouse.
  const restoreFocusRef = useRef(false);

  const listing = useAuthoritativeListing({ api, runtimeSlot, authGeneration, directory: currentPath });
  const loadAuthoritativeDirectory = useCallback((
    directory: string,
    fetchEntries: () => Promise<BrowserEntry[]>,
  ) => listing.run(directory, fetchEntries, false), [listing.run]);
  const management = useFileManagement({
    api,
    directory: currentPath,
    runtimeSlot,
    authGeneration,
    socket: directorySocket,
    onFocusedPathChange: onPreviewPathChange,
    loadAuthoritativeDirectory,
  });

  const markFocusForRestore = useCallback(() => {
    const active = document.activeElement;
    restoreFocusRef.current = entryRefs.current.some((el) => el !== null && el === active);
  }, []);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Listings belong to one computer/session. Derive the rendered view
  // synchronously from the scope they were loaded under, so a runtime switch
  // or replacement session never shows the previous owner's directory names or
  // lets stale rows fire onOpenFile/onChooseFolder against the new API.
  const { entries, status, error, scoped } = listing;
  const viewCurrentPath = scoped ? currentPath : "";
  const viewCandidatePath = scoped ? candidatePath : "";
  const viewSelectedPath = scoped ? selectedPath : null;
  const viewStatus: BrowserListingStatus = scoped ? status : "loading";
  const viewError = scoped ? error : null;
  const managementEnabled = scoped && status === "ready";
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
  const renderedPaths = useMemo(
    () => sortedEntries.map((entry) => joinPath(viewCurrentPath, entry.name)),
    [sortedEntries, viewCurrentPath],
  );
  const entriesByPath = useMemo(
    () => new Map(sortedEntries.map((entry) => [joinPath(viewCurrentPath, entry.name), entry])),
    [sortedEntries, viewCurrentPath],
  );
  // Selection is bounded by the 1,000-entry listing contract; a derived Set
  // keeps per-row checks constant-time without entering shared/store state.
  const selectedPathSet = useMemo(
    () => new Set(management.selection.selectedPaths),
    [management.selection.selectedPaths],
  );
  useEffect(() => management.reconcilePaths(renderedPaths), [management.reconcilePaths, renderedPaths]);

  const load = useCallback((path: string) => {
    if (!api) return;
    void listing.run(path, async () => {
      const response = await api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
      return parseBrowserEntries(response.entries);
    }, true).catch((caught: unknown) => {
      console.warn("[computer-file-browser] authoritative listing failed:", diagnosticErrorKind(caught));
    });
  }, [api, listing.run]);

  useEffect(() => {
    setCurrentPath("");
    setCandidatePath("");
    setSelectedPath(null);
    void load("");
    return () => {
      listing.invalidate();
    };
  }, [api, runtimeSlot, authGeneration, load, listing.invalidate]);

  const navigate = useCallback((path: string) => {
    markFocusForRestore();
    setCurrentPath(path);
    setCandidatePath(path);
    setSelectedPath(null);
    onPreviewPathChange?.(null);
    void load(path);
  }, [load, markFocusForRestore, onPreviewPathChange]);

  const goUp = useCallback(() => {
    if (viewCurrentPath) navigate(parentPath(viewCurrentPath));
  }, [navigate, viewCurrentPath]);

  const previewFile = useCallback((path: string) => {
    onOpenFile?.(path);
    onPreviewPathChange?.(path);
  }, [onOpenFile, onPreviewPathChange]);

  // Single click selects; files also open their preview immediately so the
  // browser/preview split behaves like a Finder column with Quick Look.
  const selectEntry = useCallback((entry: BrowserEntry, path: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => {
    setSelectedPath(path);
    management.selectPath(renderedPaths, path, modifiers, selectionPlatform);
    if (entry.type === "directory") setCandidatePath(path);
    else previewFile(path);
  }, [management, previewFile, renderedPaths, selectionPlatform]);

  // Double-click or Enter "opens": directories navigate, files preview.
  const activateEntry = useCallback((entry: BrowserEntry, path: string) => {
    if (entry.type === "directory") navigate(path);
    else previewFile(path);
  }, [navigate, previewFile]);

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
  // Name flexes while Size, Modified, and row actions keep aligned tracks.
  const listColumns = getFileListColumns(compact);

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
  } else if (sortedEntries.length === 0 && management.draft?.mode !== "create") {
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
      if (management.draft?.mode === "rename" && management.draft.path === path) {
        return (
          <InlineNameEditor
            key={`rename:${path}`}
            mode="rename"
            originalName={entry.name}
            kind={entry.type}
            value={management.draft.name}
            error={management.draftError}
            disabled={management.draftSubmitting}
            onChange={management.updateDraftName}
            onSubmit={() => void management.submitDraft()}
            onCancel={management.cancelDraft}
          />
        );
      }
      const entryButton = (
        <EntryButton
          key={`${entry.type}:${path}`}
          entry={entry}
          grid={view === "grid"}
          listColumns={listColumns}
          selected={mode === "folder-picker" ? viewSelectedPath === path || isCandidate : selectedPathSet.has(path)}
          pressed={mode === "folder-picker" && entry.type === "directory"
            ? isCandidate
            : mode === "browse" ? selectedPathSet.has(path) : undefined}
          buttonRef={(el) => {
            entryRefs.current[index] = el;
          }}
          onSelect={(event) => selectEntry(entry, path, event)}
          disabled={management.snapshot.pendingPaths.includes(path)}
          onNavigate={() => {
            if (entry.type === "directory") navigate(path);
          }}
          onKeyDown={(event) => onEntryKeyDown(event, entry, path, index)}
        />
      );
      if (mode === "folder-picker") return entryButton;
      const pending = management.snapshot.pendingPaths.includes(path);
      const selectedForAction = selectedPathSet.has(path)
        ? management.selection.selectedPaths
        : [path];
      const trashDisabled = selectedForAction.length > MAX_FILE_BATCH_SIZE || selectedForAction.some((selected) =>
        management.snapshot.pendingPaths.includes(selected) || !entriesByPath.get(selected)?.capabilities.canTrash);
      return (
        <ManagedFileActionMenu
          key={`${entry.type}:${path}`}
          label={entry.name}
          selected={selectedPathSet.has(path)}
          disabled={pending}
          selectedCount={management.selection.selectedPaths.length}
          canRename={entry.capabilities.canRename}
          canTrash={!trashDisabled}
          onOpen={() => activateEntry(entry, path)}
          onOpenInEditor={onOpenInEditor && entry.type === "file" ? () => onOpenInEditor(path) : undefined}
          onRename={() => management.startRename(path, entry.name)}
          onTrash={() => management.requestTrash(selectedForAction)}
          onMenuOpen={() => {
            if (!selectedPathSet.has(path)) {
              management.selectPath(
                renderedPaths,
                path, {}, selectionPlatform,
              );
            }
          }}
        >
          {entryButton}
        </ManagedFileActionMenu>
      );
    });
    const draftRow = management.draft?.mode === "create" ? (
      <InlineNameEditor
        kind={management.draft.kind}
        value={management.draft.name}
        error={management.draftError}
        disabled={management.draftSubmitting}
        onChange={management.updateDraftName}
        onSubmit={() => void management.submitDraft()}
        onCancel={management.cancelDraft}
      />
    ) : null;
    content = (
      <BrowserListing
        grid={view === "grid"} gridRef={gridRef} listColumns={listColumns}
        draftRow={draftRow} buttons={buttons} sortKey={sortKey}
        sortDirection={sortDirection} onSort={toggleSort}
      />
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
        onNewFile={mode === "browse" && managementEnabled ? () => management.startCreate("file") : undefined}
        onNewFolder={mode === "browse" && managementEnabled ? () => management.startCreate("directory") : undefined}
      />

      <FileOperationNotice snapshot={management.snapshot} localNotice={management.localNotice} />

      {mode === "browse" && managementEnabled ? (
        <FileCreationContextMenu
          onNewFile={() => management.startCreate("file")}
          onNewFolder={() => management.startCreate("directory")}
        >
          <div data-testid="files-listing" className={`${compact ? "h-52" : "min-h-0 flex-1"} overflow-y-auto p-1.5`}>{content}</div>
        </FileCreationContextMenu>
      ) : (
        <div className={`${compact ? "h-52" : "min-h-0 flex-1"} overflow-y-auto p-1.5`}>{content}</div>
      )}

      {onChooseFolder ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
          <span className="min-w-0 truncate text-xs" style={{ color: "var(--text-secondary)" }} title={viewCandidatePath || "Matrix home"}>
            {viewCandidatePath || "Matrix home"}
          </span>
          <Button variant="primary" disabled={!viewCandidatePath} onClick={() => onChooseFolder(viewCandidatePath)}>
            Choose {chosenName}
          </Button>
        </div>
      ) : null}
      <MoveToTrashDialog
        paths={management.trashPaths}
        pending={management.snapshot.status === "pending"}
        onCancel={management.cancelTrash}
        onConfirm={() => void management.confirmTrash()}
      />
    </div>
  );
}

function defaultSelectionPlatform(): FileSelectionPlatform {
  const platform = globalThis.navigator?.platform ?? "";
  if (/mac/i.test(platform)) return "mac";
  if (/win/i.test(platform)) return "windows";
  return "linux";
}
