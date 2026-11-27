import { ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, FilePlus, FolderPlus, LayoutGrid, List, Plus, Search, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Button, DropdownMenu, Icon, IconButton, SegmentedControl, type MenuEntry } from "../../../design/ds";
import type { BrowserSortDirection, BrowserSortKey } from "../browser-entries";

export type FilesView = "grid" | "list";

/** 48px top row: back and forward, then folder tabs (or a breadcrumb), then trailing controls. */
export function FilesTopBar({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  center,
  trailing,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  center: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ds-tint-neutral-border px-3">
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Back" shortcut="⌘[" size="xs" disabled={!canGoBack} onClick={onBack}><Icon icon={ChevronLeft} size="sm" /></IconButton>
        <IconButton label="Forward" shortcut="⌘]" size="xs" disabled={!canGoForward} onClick={onForward}><Icon icon={ChevronRight} size="sm" /></IconButton>
      </div>
      <div className="min-w-0 flex-1">{center}</div>
      {trailing ? <div className="flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </div>
  );
}

const SORT_LABEL: Record<BrowserSortKey, string> = { name: "Name", size: "Size", modified: "Modified" };

/**
 * Page header: title and count on the left; search, Grid/List, Sort, Upload and
 * the one primary action (New) on the right. Write actions are omitted, not
 * disabled, when the folder is read-only.
 */
export function FilesHeader({
  title,
  summary,
  titleAdornment,
  view,
  onViewChange,
  sortKey,
  sortDirection,
  onSortChange,
  onSearch,
  onUpload,
  onNewFolder,
  onNewFile,
}: {
  title: string;
  summary: string;
  titleAdornment?: ReactNode;
  view: FilesView;
  onViewChange: (view: FilesView) => void;
  sortKey: BrowserSortKey;
  sortDirection: BrowserSortDirection;
  onSortChange: (key: BrowserSortKey, direction: BrowserSortDirection) => void;
  onSearch?: () => void;
  onUpload?: () => void;
  onNewFolder?: () => void;
  onNewFile?: () => void;
}) {
  const sortEntries: MenuEntry[] = [
    { kind: "label", id: "sort-by", label: "Sort by" },
    {
      kind: "radio",
      id: "sort-key",
      value: sortKey,
      onValueChange: (value) => onSortChange(value as BrowserSortKey, sortDirection),
      options: (Object.keys(SORT_LABEL) as BrowserSortKey[]).map((key) => ({ value: key, label: SORT_LABEL[key] })),
    },
    { kind: "separator", id: "sort-separator" },
    { kind: "label", id: "order", label: "Order" },
    {
      kind: "radio",
      id: "sort-direction",
      value: sortDirection,
      onValueChange: (value) => onSortChange(sortKey, value as BrowserSortDirection),
      options: [{ value: "asc", label: "Ascending" }, { value: "desc", label: "Descending" }],
    },
  ];
  const newEntries: MenuEntry[] = [
    ...(onNewFolder ? [{ kind: "item" as const, id: "new-folder", label: "New folder", shortcut: "⇧⌘N", icon: <FolderPlus />, onSelect: onNewFolder }] : []),
    ...(onNewFile ? [{ kind: "item" as const, id: "new-file", label: "New file", shortcut: "⌥⌘N", icon: <FilePlus />, onSelect: onNewFile }] : []),
    ...(onUpload ? [
      { kind: "separator" as const, id: "upload-separator" },
      { kind: "label" as const, id: "upload-label", label: "Upload" },
      { kind: "item" as const, id: "upload-files", label: "Upload files…", shortcut: "⌘U", icon: <Upload />, onSelect: onUpload },
    ] : []),
  ];
  return (
    <header className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-3 px-6 pt-5 pb-4 font-ds-sans">
      <div className="min-w-40 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-ds-ui-lg font-semibold text-ds-foreground" title={title}>{title}</h2>
          {titleAdornment}
        </div>
        <p data-files-summary className="truncate text-ds-ui-sm whitespace-nowrap text-ds-muted-foreground">{summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onSearch ? <IconButton label="Search" shortcut="⌘F" variant="secondary" onClick={onSearch}><Icon icon={Search} size="sm" /></IconButton> : null}
        <SegmentedControl
          label="View"
          iconOnly
          value={view}
          onChange={onViewChange}
          options={[
            { value: "grid", label: "Grid", icon: <Icon icon={LayoutGrid} size="sm" /> },
            { value: "list", label: "List", icon: <Icon icon={List} size="sm" /> },
          ]}
        />
        <DropdownMenu
          align="end"
          entries={sortEntries}
          trigger={(
            <Button variant="ghost" size="sm" aria-label={`Sort by ${SORT_LABEL[sortKey]}`}>
              <Icon icon={ArrowUpDown} size="sm" />
              {SORT_LABEL[sortKey]}
              <Icon icon={ChevronDown} size="xs" />
            </Button>
          )}
        />
        {onUpload ? <IconButton label="Upload files" shortcut="⌘U" variant="secondary" onClick={onUpload}><Icon icon={Upload} size="sm" /></IconButton> : null}
        {newEntries.length > 0 ? (
          <DropdownMenu
            align="end"
            entries={newEntries}
            trigger={(
              <Button variant="primary" size="sm">
                <Icon icon={Plus} size="sm" />
                New
                <Icon icon={ChevronDown} size="xs" />
              </Button>
            )}
          />
        ) : null}
      </div>
    </header>
  );
}

/** 32px status bar: count or "N of M selected" on the left, sync state on the right. */
export function FilesStatusBar({ total, selected, sync }: { total: number; selected: number; sync?: ReactNode }) {
  const left = selected > 0 ? `${selected} of ${total} selected` : `${total} ${total === 1 ? "item" : "items"}`;
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-t border-ds-tint-neutral-border px-4 font-ds-sans text-ds-ui-xs text-ds-muted-foreground">
      <span aria-live="polite" className="tabular-nums">{left}</span>
      {sync ? <span className="flex items-center gap-1.5">{sync}</span> : null}
    </div>
  );
}
