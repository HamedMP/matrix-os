// Presentational pieces of the computer file browser: the view segmented
// control, sortable list header, per-entry tile/row, and the path toolbar.
// State, loading, and keyboard orchestration live in ComputerFileBrowser.
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Home,
  FolderPlus,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { Button, IconButton } from "../../design/primitives";
import type { BrowserEntry, BrowserSortDirection } from "./browser-entries";
import type { BrowserViewMode } from "./browser-view-preference";
import type { FileUploadRow } from "./file-upload-controller";
import { FileGlyph, kindForEntry } from "./file-kind";
import { formatEntrySize, formatModified } from "./format";

const VIEW_OPTIONS: Array<{ mode: BrowserViewMode; label: string; icon: typeof LayoutGrid }> = [
  { mode: "grid", label: "Grid view", icon: LayoutGrid },
  { mode: "list", label: "List view", icon: List },
];

export function hasRegularDroppedFiles(dataTransfer: DataTransfer): boolean {
  if (!dataTransfer.items || dataTransfer.items.length === 0) return dataTransfer.files.length > 0;
  return Array.from(dataTransfer.items).some((item) => {
    if (item.kind !== "file") return false;
    const entry = "webkitGetAsEntry" in item
      ? (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.()
      : null;
    return !entry?.isDirectory;
  });
}

export function regularDroppedFiles(dataTransfer: DataTransfer): File[] {
  if (!dataTransfer.items || dataTransfer.items.length === 0) return Array.from(dataTransfer.files);
  return Array.from(dataTransfer.items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = "webkitGetAsEntry" in item
      ? (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.()
      : null;
    if (entry?.isDirectory) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

// ArrowUp/ArrowDown in grid view move by a visual row. Columns are measured
// from the rendered tiles; jsdom (offsetWidth 0) and unmeasured layouts fall
// back to single-step movement.
export function measureGridColumns(container: HTMLElement | null): number {
  if (!container) return 1;
  const tiles = container.querySelectorAll<HTMLElement>("[data-grid-tile]");
  const first = tiles[0];
  if (!first || first.offsetWidth === 0) return 1;
  const top = first.offsetTop;
  let columns = 0;
  for (const tile of tiles) {
    if (tile.offsetTop !== top) break;
    columns += 1;
  }
  return Math.max(1, columns);
}

export function ViewSwitcher({
  view,
  onChange,
}: {
  view: BrowserViewMode;
  onChange: (view: BrowserViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="View options"
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
      style={{ background: "var(--bg-hover)", borderColor: "var(--border-subtle)" }}
    >
      {VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => {
        const active = view === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => onChange(mode)}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            style={{
              background: active ? "var(--bg-selected)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-tertiary)",
            }}
          >
            <Icon size={16} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function SortHeader({
  label,
  sortLabel,
  active,
  direction,
  alignEnd = false,
  onClick,
}: {
  label: string;
  sortLabel: string;
  active: boolean;
  direction: BrowserSortDirection;
  alignEnd?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={sortLabel}
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
        alignEnd ? "justify-end" : "justify-start"
      }`}
      style={{ color: active ? "var(--text-primary)" : "var(--text-tertiary)" }}
    >
      <span className="truncate">{label}</span>
      {active ? (
        direction === "asc" ? (
          <ChevronUp size={11} aria-hidden />
        ) : (
          <ChevronDown size={11} aria-hidden />
        )
      ) : null}
    </button>
  );
}

// One browser entry, rendered as a grid tile or a list row depending on the
// active view. The row/tile is a single button so click, double-click, and
// keyboard handling stay identical across views.
export function EntryButton({
  entry,
  grid,
  listColumns,
  compact = false,
  selected,
  pressed,
  managed,
  buttonRef,
  onSelect,
  onNavigate,
  onKeyDown,
  onDropFiles,
  contextPath,
}: {
  entry: BrowserEntry;
  grid: boolean;
  listColumns: string;
  compact?: boolean;
  selected: boolean;
  pressed: boolean | undefined;
  managed?: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onNavigate: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onDropFiles?: (files: File[]) => void;
  contextPath?: string;
}) {
  const kind = kindForEntry(entry);
  const glyphColor = entry.type === "directory" ? "var(--accent)" : "var(--text-tertiary)";

  if (grid) {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Open ${entry.name}`}
        aria-pressed={pressed}
        data-grid-tile
        data-files-entry-path={contextPath}
        className="flex w-24 flex-col items-center gap-1.5 rounded-lg px-1.5 py-2.5 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        style={{ background: selected ? "var(--bg-selected)" : "transparent" }}
        onClick={onSelect}
        onDoubleClick={onNavigate}
        onKeyDown={onKeyDown}
        onDragOver={(event) => {
          if (!onDropFiles || !hasRegularDroppedFiles(event.dataTransfer)) return;
          event.preventDefault();
        }}
        onDrop={(event: DragEvent<HTMLButtonElement>) => {
          if (!onDropFiles || !hasRegularDroppedFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          onDropFiles(regularDroppedFiles(event.dataTransfer));
        }}
      >
        <span style={{ color: glyphColor }}>
          <FileGlyph kind={kind} size={34} />
        </span>
        <span
          className="line-clamp-2 w-full break-words text-center text-xs leading-tight"
          style={{ color: "var(--text-primary)" }}
          title={entry.name}
        >
          {entry.name}
        </span>
        {managed ? (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: "var(--text-tertiary)", background: "var(--bg-hover)" }}>
            Managed
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Open ${entry.name}`}
      aria-pressed={pressed}
      data-files-list-row
      data-files-entry-path={contextPath}
      className={`grid w-full items-center outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${compact
        ? "h-9 gap-1 rounded-md px-2 text-left text-sm"
        : "h-[54px] gap-4 rounded-none border-b px-4 text-left text-base font-medium last:border-b-0"}`}
      style={{
        gridTemplateColumns: listColumns,
        background: selected ? "var(--bg-selected)" : "transparent",
        borderColor: compact ? undefined : "var(--border-subtle)",
        color: "var(--text-primary)",
      }}
      onClick={onSelect}
      onDoubleClick={onNavigate}
      onKeyDown={onKeyDown}
      onDragOver={(event) => {
        if (!onDropFiles || !hasRegularDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDropFiles || !hasRegularDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        onDropFiles(regularDroppedFiles(event.dataTransfer));
      }}
    >
      <span className={`flex min-w-0 items-center ${compact ? "gap-2" : "gap-4"}`}>
        <span className="shrink-0" style={{ color: glyphColor }}>
          <FileGlyph kind={kind} size={compact ? 16 : 20} />
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </span>
      <span className="truncate text-right text-[13px] font-normal" style={{ color: "var(--text-tertiary)" }}>
        {managed ? "Managed" : formatEntrySize(entry)}
      </span>
      <span className="truncate text-right text-[13px] font-normal" style={{ color: "var(--text-tertiary)" }}>
        {formatModified(entry.modifiedAt)}
      </span>
    </button>
  );
}

export function BrowserToolbar({
  compact,
  currentPath,
  crumbs,
  view,
  onViewChange,
  onUp,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  readOnly,
  onNavigate,
  onRefresh,
  onUpload,
  searchOpen,
  searchQuery,
  onSearchOpen,
  onSearchClose,
  onSearchQueryChange,
}: {
  compact: boolean;
  currentPath: string;
  crumbs: Array<{ label: string; path: string }>;
  view: BrowserViewMode;
  onViewChange: (view: BrowserViewMode) => void;
  onUp: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  readOnly?: boolean;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onUpload?: () => void;
  searchOpen: boolean;
  searchQuery: string;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  onSearchQueryChange: (query: string) => void;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const previousSearchOpenRef = useRef(searchOpen);

  useEffect(() => {
    if (previousSearchOpenRef.current && !searchOpen) {
      toolbarRef.current?.querySelector<HTMLButtonElement>("[data-files-search-trigger]")?.focus();
    }
    previousSearchOpenRef.current = searchOpen;
  }, [searchOpen]);

  return (
    <div ref={toolbarRef} data-files-toolbar className="flex h-[37px] shrink-0 items-center gap-1 border-b" style={{ borderColor: "var(--border-subtle)" }}>
      <IconButton label="Back" className="h-8 w-8 shrink-0 disabled:opacity-40" disabled={!canGoBack} onClick={onBack}>
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton label="Forward" className="h-8 w-8 shrink-0 disabled:opacity-40" disabled={!canGoForward} onClick={onForward}>
        <ArrowRight size={16} />
      </IconButton>
      {currentPath ? (
        <IconButton label="Up one level" className="h-8 w-8 shrink-0" onClick={onUp}>
          <ArrowUp size={16} />
        </IconButton>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          type="button"
          aria-label="Matrix home"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium hover:bg-[var(--bg-hover)]"
          style={{ color: currentPath ? "var(--text-secondary)" : "var(--text-primary)" }}
          onClick={() => onNavigate("")}
        >
          <Home size={16} />
          {!compact ? "Matrix home" : "Home"}
          {!compact ? <ChevronDown size={16} aria-hidden /> : null}
        </button>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="flex min-w-0 items-center gap-1">
            <ChevronRight size={11} style={{ color: "var(--text-tertiary)" }} />
            <button
              type="button"
              className="max-w-[150px] truncate rounded px-1.5 py-1 text-xs hover:bg-[var(--bg-hover)]"
              style={{ color: crumb.path === currentPath ? "var(--text-primary)" : "var(--text-secondary)" }}
              onClick={() => onNavigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>
      {readOnly ? (
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: "var(--text-tertiary)", background: "var(--bg-hover)" }}>
          Read only
        </span>
      ) : null}
      {currentPath ? (
        <IconButton label="Refresh folder" className="h-8 w-8 shrink-0" onClick={onRefresh}>
          <RefreshCw size={16} />
        </IconButton>
      ) : null}
      <ViewSwitcher view={view} onChange={onViewChange} />
      {searchOpen ? (
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2 sm:max-w-48" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
          <Search size={16} aria-hidden style={{ color: "var(--text-tertiary)" }} />
          <input
            type="text"
            role="searchbox"
            aria-label="Search files"
            autoFocus
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onSearchClose();
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
            placeholder="Search files"
          />
          <button type="button" aria-label="Close file search" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" onClick={onSearchClose}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : (
        <IconButton data-files-search-trigger label="Search files" className="h-8 w-8 shrink-0 border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }} onClick={onSearchOpen}>
          <Search size={16} />
        </IconButton>
      )}
      {onUpload ? (
        <IconButton label="Upload files" className="h-8 w-8 shrink-0 border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }} onClick={onUpload}>
          <Upload size={16} />
        </IconButton>
      ) : null}
    </div>
  );
}

export function UploadStatusList({
  uploads,
  onRetry,
  onRemove,
}: {
  uploads: FileUploadRow[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (uploads.length === 0) return null;
  return (
    <div className="shrink-0 space-y-1 border-t px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)" }} aria-live="polite">
      {uploads.slice(0, 4).map((upload) => (
        <div key={upload.id} className="flex min-h-7 items-center justify-between gap-2">
          <span className="min-w-0 truncate">{upload.name}: {upload.error ?? upload.status}</span>
          {upload.status === "failed" ? (
            <span className="flex shrink-0 items-center gap-1">
              {upload.error !== "Files are limited to 10 MB." ? (
                <Button variant="subtle" className="h-7 text-xs" onClick={() => onRetry(upload.id)}>Retry</Button>
              ) : null}
              <Button variant="ghost" className="h-7 text-xs" onClick={() => onRemove(upload.id)}>Remove</Button>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function FolderPickerFooter({
  path,
  message,
  actionLabel,
  disabled,
  onAction,
  onCreateFolder,
}: {
  path: string;
  message?: string;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
  onCreateFolder?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
      <div className="min-w-0">
        <div className="truncate text-xs" style={{ color: "var(--text-secondary)" }} title={path || "Matrix home"}>
          {path || "Matrix home"}
        </div>
        {message ? <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>{message}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onCreateFolder ? (
          <Button
            variant="subtle"
            aria-label={`New folder in ${path}`}
            onClick={onCreateFolder}
          >
            <FolderPlus size={13} aria-hidden />
            New folder here
          </Button>
        ) : null}
        <Button variant="primary" disabled={disabled} onClick={onAction}>{actionLabel}</Button>
      </div>
    </div>
  );
}
