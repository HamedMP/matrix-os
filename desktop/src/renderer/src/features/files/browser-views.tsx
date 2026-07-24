// Presentational pieces of the computer file browser: the view segmented
// control, sortable list header, per-entry tile/row, and the path toolbar.
// State, loading, and keyboard orchestration live in ComputerFileBrowser.
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Home,
  LayoutGrid,
  List,
  RefreshCw,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { IconButton } from "../../design/primitives";
import type { BrowserEntry, BrowserSortDirection } from "./browser-entries";
import type { BrowserViewMode } from "./browser-view-preference";
import { FileGlyph, kindForEntry } from "./file-kind";
import { formatEntrySize, formatModified } from "./format";

const VIEW_OPTIONS: Array<{ mode: BrowserViewMode; label: string; icon: typeof LayoutGrid }> = [
  { mode: "grid", label: "Grid view", icon: LayoutGrid },
  { mode: "list", label: "List view", icon: List },
];

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
      className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
      style={{ background: "var(--bg-hover)" }}
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
            className="flex h-6 w-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            style={{
              background: active ? "var(--bg-selected)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-tertiary)",
            }}
          >
            <Icon size={13} aria-hidden />
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
  selected,
  pressed,
  buttonRef,
  onSelect,
  onNavigate,
  onKeyDown,
}: {
  entry: BrowserEntry;
  grid: boolean;
  listColumns: string;
  selected: boolean;
  pressed: boolean | undefined;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onNavigate: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
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
        className="flex w-24 flex-col items-center gap-1.5 rounded-lg px-1.5 py-2.5 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        style={{ background: selected ? "var(--bg-selected)" : "transparent" }}
        onClick={onSelect}
        onDoubleClick={onNavigate}
        onKeyDown={onKeyDown}
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
      </button>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Open ${entry.name}`}
      aria-pressed={pressed}
      className="grid h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      style={{
        gridTemplateColumns: listColumns,
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text-primary)",
      }}
      onClick={onSelect}
      onDoubleClick={onNavigate}
      onKeyDown={onKeyDown}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0" style={{ color: glyphColor }}>
          <FileGlyph kind={kind} size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </span>
      <span className="truncate text-right text-xs" style={{ color: "var(--text-tertiary)" }}>
        {formatEntrySize(entry)}
      </span>
      <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
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
  onNavigate,
  onRefresh,
}: {
  compact: boolean;
  currentPath: string;
  crumbs: Array<{ label: string; path: string }>;
  view: BrowserViewMode;
  onViewChange: (view: BrowserViewMode) => void;
  onUp: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--border-subtle)" }}>
      <IconButton
        label="Up one level"
        className="shrink-0 disabled:opacity-40"
        disabled={!currentPath}
        onClick={onUp}
      >
        <ArrowUp size={13} />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          type="button"
          aria-label="Matrix home"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
          style={{ color: currentPath ? "var(--text-secondary)" : "var(--text-primary)" }}
          onClick={() => onNavigate("")}
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
              onClick={() => onNavigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>
      <ViewSwitcher view={view} onChange={onViewChange} />
      <IconButton label="Refresh folder" className="shrink-0" onClick={onRefresh}>
        <RefreshCw size={13} />
      </IconButton>
    </div>
  );
}
