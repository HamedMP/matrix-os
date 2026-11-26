import { PanelRight, Search, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { toast } from "sonner";
import { Badge, Icon, IconButton, Input } from "../../../design/ds";
import { useConnection } from "../../../stores/connection";
import { openExactFileInDesktopEditor } from "../../editor/desktop-editor-store";
import { isManagedBrowserPath, isProtectedFolderCreationParentPath, sortBrowserEntries, type BrowserEntry, type BrowserSortDirection, type BrowserSortKey } from "../browser-entries";
import { useBrowserHistory } from "../browser-history";
import { useBrowserViewPreference } from "../browser-view-preference";
import { UploadStatusList } from "../browser-views";
import { previewKindForPath } from "../FilePreviewPane";
import { canMoveFileToTrash } from "../FileTrashControls";
import { useFileUploads } from "../use-file-uploads";
import { DetailsPanel, DetailsPlaceholder } from "./DetailsPanel";
import { FolderContent } from "./FolderContent";
import { FilesHeader, FilesStatusBar, FilesTopBar, type FilesView } from "./FilesHeader";
import { countSummary, type FolderAccess } from "./file-presentation";
import { SelectionBar } from "./SelectionBar";
import { gridColumnCount, useEntryNavigation } from "./use-entry-navigation";
import { useFolderListing } from "./use-folder-listing";
import { paneShortcut, useDropUpload, useEmptySpaceDismiss, type PaneShortcut } from "./pane-input";
import { clearSelection } from "./selection-model";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export function pathTitle(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "Matrix home";
}

function accessFor(path: string): FolderAccess {
  return isManagedBrowserPath(path) ? "managed" : "own";
}

/** Lets the workspace send this tab to a sidebar location. */
export interface FolderPaneHandle {
  navigate: (path: string) => void;
}

export interface FolderPaneProps {
  ref?: Ref<FolderPaneHandle>;
  initialPath: string;
  tabs: ReactNode;
  refreshRevision: number;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  onPathChange: (path: string) => void;
  onOpenFolderInNewTab: (path: string) => void;
  onRequestCreate: (kind: "file" | "folder", parentPath: string) => void;
  onDownload: (path: string, size?: number) => void;
  downloadPending: boolean;
  onRequestTrash: (path: string, type: BrowserEntry["type"]) => void;
}

/** One folder tab of the redesigned Files: top row, header, grid or list, details, status. */
export function FolderPane({
  ref,
  initialPath,
  tabs,
  refreshRevision,
  detailsOpen,
  onDetailsOpenChange,
  onPathChange,
  onOpenFolderInNewTab,
  onRequestCreate,
  onDownload,
  downloadPending,
  onRequestTrash,
}: FolderPaneProps) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const storedView = useBrowserViewPreference((state) => state.view);
  const setStoredView = useBrowserViewPreference((state) => state.setView);
  const view: FilesView = storedView === "list" ? "list" : "grid";
  const history = useBrowserHistory(initialPath);
  const path = history.currentPath;
  const listing = useFolderListing(path);
  const [sortKey, setSortKey] = useState<BrowserSortKey>("name");
  const [sortDirection, setSortDirection] = useState<BrowserSortDirection>("asc");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const folderGridRef = useRef<HTMLDivElement | null>(null);
  const readOnly = isManagedBrowserPath(path);
  const canCreate = listing.status === "ready" && !isProtectedFolderCreationParentPath(path);

  const { reload } = listing;
  useEffect(() => { if (refreshRevision > 0) reload(); }, [refreshRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const filtered = needle ? listing.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)) : listing.entries;
    return sortBrowserEntries(filtered, sortKey, sortDirection);
  }, [filter, listing.entries, sortDirection, sortKey]);
  const order = useMemo(() => visible.map((entry) => joinPath(path, entry.name)), [path, visible]);
  const names = useMemo(() => visible.map((entry) => entry.name), [visible]);
  const byPath = useMemo(() => new Map(visible.map((entry, index) => [order[index]!, entry])), [order, visible]);

  const navigate = useCallback((next: string) => {
    history.pushPath(next);
    setFilter("");
    setFilterOpen(false);
    onPathChange(next);
  }, [history, onPathChange]);

  useImperativeHandle(ref, () => ({
    navigate: (next: string) => { if (next !== path) navigate(next); },
  }), [navigate, path]);

  useEffect(() => {
    history.resetHistory();
    onPathChange(initialPath);
  }, [runtimeSlot, authGeneration]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEntry = useCallback((entryPath: string) => {
    const entry = byPath.get(entryPath);
    if (!entry) return;
    if (entry.type === "directory") { navigate(entryPath); return; }
    const kind = previewKindForPath(entryPath);
    if ((kind === "text" || kind === "markdown") && openExactFileInDesktopEditor(entryPath)) return;
    onDetailsOpenChange(true);
  }, [byPath, navigate, onDetailsOpenChange]);

  const sections = useMemo(() => {
    const folderCount = visible.filter((entry) => entry.type === "directory").length;
    return [folderCount, visible.length - folderCount].filter((size) => size > 0);
  }, [visible]);
  const nav = useEntryNavigation({
    order,
    names,
    columns: () => (view === "grid" ? gridColumnCount(folderGridRef.current) : 1),
    sections: view === "grid" ? sections : undefined,
    onOpen: openEntry,
  });

  // The upload controller must outlive folder navigation (queued files would be
  // dropped if it were recreated), so it gets a stable callback that reloads
  // whichever folder is current.
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);
  const onUploaded = useCallback(() => reloadRef.current(), []);
  // Always enabled: entering a read-only folder must not drop uploads queued for
  // another folder. Read-only folders simply offer no upload controls.
  const uploads = useFileUploads({ api, browserScope: `${runtimeSlot}|${authGeneration}`, currentPath: path, enabled: true, onUploaded });
  const enqueue = useCallback((files: File[], destination = path) => uploads.enqueue(files, destination), [path, uploads]);

  const goBack = () => { if (history.backPath !== null) { history.moveBack(); onPathChange(history.backPath); } };
  const goForward = () => { if (history.forwardPath !== null) { history.moveForward(); onPathChange(history.forwardPath); } };
  const goUp = () => { if (path) navigate(parentPath(path)); };

  const single = nav.selection.selected.length === 1 ? nav.selection.selected[0]! : null;
  const singleEntry = single ? byPath.get(single) : undefined;

  const openFilter = () => { setFilterOpen(true); requestAnimationFrame(() => filterRef.current?.focus()); };
  const shortcuts: Record<PaneShortcut, (() => void) | null> = {
    "toggle-details": () => onDetailsOpenChange(!detailsOpen),
    find: openFilter,
    back: goBack,
    forward: goForward,
    up: goUp,
    upload: readOnly ? null : () => fileInputRef.current?.click(),
  };
  const onPaneKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // An entry's Escape clears the selection first (and prevents default); the next Escape closes details.
    if (event.key === "Escape" && !event.defaultPrevented && detailsOpen) {
      event.preventDefault();
      onDetailsOpenChange(false);
      return;
    }
    const shortcut = paneShortcut(event);
    const run = shortcut ? shortcuts[shortcut] : null;
    if (!run) return;
    event.preventDefault();
    run();
  };
  const drop = useDropUpload(!readOnly, (files) => enqueue(files));
  // Light dismiss for pointer users (Escape covers the keyboard): empty space in
  // the listing clears the selection and closes details; entries and controls do not.
  const listingRef = useRef<HTMLDivElement | null>(null);
  useEmptySpaceDismiss(listingRef, () => {
    nav.setSelection(clearSelection());
    if (detailsOpen) onDetailsOpenChange(false);
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ds-background" onKeyDown={onPaneKeyDown}>
      <FilesTopBar
        canGoBack={history.canGoBack}
        canGoForward={history.canGoForward}
        onBack={goBack}
        onForward={goForward}
        center={tabs}
        trailing={(
          <IconButton label={detailsOpen ? "Hide details" : "Show details"} shortcut="⌘I" size="xs" aria-pressed={detailsOpen} onClick={() => onDetailsOpenChange(!detailsOpen)}>
            <Icon icon={PanelRight} size="sm" />
          </IconButton>
        )}
      />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <FilesHeader
            title={pathTitle(path)}
            summary={listing.status === "ready" ? countSummary(listing.entries) : " "}
            titleAdornment={readOnly ? <Badge>Managed</Badge> : null}
            view={view}
            onViewChange={(next) => setStoredView(next)}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSortChange={(key, direction) => { setSortKey(key); setSortDirection(direction); }}
            onSearch={openFilter}
            onUpload={readOnly ? undefined : () => fileInputRef.current?.click()}
            onNewFolder={canCreate ? () => onRequestCreate("folder", path) : undefined}
            onNewFile={canCreate ? () => onRequestCreate("file", path) : undefined}
          />
          {filterOpen ? (
            <div className="flex items-center gap-2 px-6 pb-3">
              <Icon icon={Search} size="sm" className="text-ds-muted-foreground" />
              <Input ref={filterRef} inputSize="sm" aria-label={`Filter ${pathTitle(path)}`} placeholder={`Filter ${pathTitle(path)}`} value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") { setFilter(""); setFilterOpen(false); } }} />
              <IconButton label="Close filter" size="xs" onClick={() => { setFilter(""); setFilterOpen(false); }}><Icon icon={X} size="sm" /></IconButton>
            </div>
          ) : null}
          <div
            data-testid="files-redesign-listing"
            className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-20"
            ref={listingRef}
            {...drop.handlers}
          >
            <FolderContent
              title={pathTitle(path)}
              status={listing.status}
              error={listing.error}
              onRetry={reload}
              entries={visible}
              order={order}
              filterActive={filter.trim().length > 0}
              view={view}
              nav={nav}
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSort={(key) => {
                if (key === sortKey) setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
                else { setSortKey(key); setSortDirection("asc"); }
              }}
              gridRef={folderGridRef}
              onDropFiles={enqueue}
              onUpload={readOnly ? undefined : () => fileInputRef.current?.click()}
              onNewFile={canCreate ? () => onRequestCreate("file", path) : undefined}
              onClearFilter={() => setFilter("")}
            />
            {drop.active ? (
              <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-ds-border-strong bg-ds-accent text-ds-ui font-medium text-ds-foreground">
                Drop to upload to {pathTitle(path)}
              </div>
            ) : null}
          </div>
          <SelectionBar
            count={nav.selection.selected.length >= 2 ? nav.selection.selected.length : 0}
            actions={[]}
            onClear={() => nav.setSelection(clearSelection())}
          />
          <UploadStatusList uploads={uploads.uploads} onRetry={uploads.retry} onRemove={uploads.remove} />
          <FilesStatusBar total={visible.length} selected={nav.selection.selected.length} />
        </div>
        {detailsOpen && singleEntry && single ? (
          <DetailsPanel
            key={single}
            entry={singleEntry}
            path={single}
            access={accessFor(single)}
            onClose={() => onDetailsOpenChange(false)}
            onOpen={() => (singleEntry.type === "directory" ? navigate(single) : openEntry(single))}
            onOpenInNewTab={singleEntry.type === "directory" ? () => onOpenFolderInNewTab(single) : undefined}
            onOpenInEditor={singleEntry.type === "file" ? () => { if (!openExactFileInDesktopEditor(single)) toast.error("The file could not be opened in the editor."); } : undefined}
            onDownload={singleEntry.type === "file" ? () => onDownload(single, singleEntry.sizeBytes) : undefined}
            downloadPending={downloadPending}
            onTrash={canMoveFileToTrash(single) && !isManagedBrowserPath(single) ? () => onRequestTrash(single, singleEntry.type) : undefined}
          />
        ) : detailsOpen ? (
          <DetailsPlaceholder count={nav.selection.selected.length} onClose={() => onDetailsOpenChange(false)} />
        ) : null}
      </div>
      {!readOnly ? (
        <input ref={fileInputRef} type="file" multiple className="sr-only" aria-label="Choose files to upload"
          onChange={(event) => { enqueue(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
      ) : null}
    </div>
  );
}
