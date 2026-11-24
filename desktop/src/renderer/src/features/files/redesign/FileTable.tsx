import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Badge, Checkbox, Icon, type CheckedState } from "../../../design/ds";
import { cn } from "../../../lib/cn";
import type { BrowserEntry, BrowserSortDirection, BrowserSortKey } from "../browser-entries";
import { formatEntrySize, formatModified } from "../format";
import { entryDragProps } from "./entry-drag";
import type { EntryHandlers } from "./FileCard";
import { kindLabel, type FolderAccess } from "./file-presentation";
import { FileTile } from "./FileTile";

export const FILE_TABLE_COLUMNS = "40px minmax(0,1fr) 120px 96px 140px 112px";

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  alignEnd = false,
}: {
  label: string;
  sortKey: BrowserSortKey;
  activeKey: BrowserSortKey;
  direction: BrowserSortDirection;
  onSort: (key: BrowserSortKey) => void;
  alignEnd?: boolean;
}) {
  const active = sortKey === activeKey;
  return (
    <div role="columnheader" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} className={cn("flex", alignEnd && "justify-end")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("ds-focus inline-flex h-6 items-center gap-1 rounded-sm text-ds-cap font-medium tracking-[0.04em] uppercase", active ? "text-ds-foreground" : "text-ds-muted-foreground hover:text-ds-foreground")}
      >
        {label}
        {active ? <Icon icon={direction === "asc" ? ArrowUp : ArrowDown} size="xxs" /> : null}
      </button>
    </div>
  );
}

function PlainHeader({ label, alignEnd = false }: { label: string; alignEnd?: boolean }) {
  return <div role="columnheader" className={cn("text-ds-cap font-medium tracking-[0.04em] text-ds-muted-foreground uppercase", alignEnd && "text-right")}>{label}</div>;
}

/** List view: a selectable grid with a header checkbox and sortable columns. */
export function FileTable({
  label,
  headerChecked,
  onHeaderCheckedChange,
  sortKey,
  sortDirection,
  onSort,
  children,
}: {
  label: string;
  headerChecked: CheckedState;
  onHeaderCheckedChange: (next: boolean) => void;
  sortKey: BrowserSortKey;
  sortDirection: BrowserSortDirection;
  onSort: (key: BrowserSortKey) => void;
  children: ReactNode;
}) {
  return (
    <div role="grid" aria-label={label} aria-multiselectable="true" className="min-w-0 font-ds-sans">
      <div role="rowgroup" className="sticky top-0 z-10 bg-ds-background">
        <div role="row" className="grid h-9 items-center gap-3 border-b border-ds-tint-neutral-border px-3" style={{ gridTemplateColumns: FILE_TABLE_COLUMNS }}>
          <div role="columnheader" className="flex items-center">
            <Checkbox aria-label="Select all" checked={headerChecked} onCheckedChange={onHeaderCheckedChange} />
          </div>
          <SortableHeader label="Name" sortKey="name" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
          <PlainHeader label="Kind" />
          <SortableHeader label="Size" sortKey="size" activeKey={sortKey} direction={sortDirection} onSort={onSort} alignEnd />
          <SortableHeader label="Modified" sortKey="modified" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
          <PlainHeader label="Access" />
        </div>
      </div>
      <div role="rowgroup">{children}</div>
    </div>
  );
}

const ACCESS_LABEL: Record<FolderAccess, string> = { own: "Only you", shared: "Shared", managed: "Managed" };

export function FileRow({
  entry,
  path,
  access = "own",
  selected,
  focusable,
  handlers,
  onToggle,
  rowRef,
  attachmentPath,
  onDropFiles,
  now,
}: {
  entry: BrowserEntry;
  path: string;
  access?: FolderAccess;
  selected: boolean;
  focusable: boolean;
  handlers: EntryHandlers;
  /** The row checkbox: toggles this row without clearing others. */
  onToggle: () => void;
  rowRef?: Ref<HTMLDivElement>;
  attachmentPath?: string;
  onDropFiles?: (files: File[]) => void;
  now?: Date;
}) {
  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selected}
      aria-label={entry.name}
      tabIndex={focusable ? 0 : -1}
      data-files-entry-path={path}
      data-files-row
      {...entryDragProps<HTMLDivElement>({ attachmentPath, onDropFiles })}
      onClick={handlers.onClick}
      onDoubleClick={handlers.onDoubleClick}
      onKeyDown={handlers.onKeyDown}
      onFocus={handlers.onFocus}
      className={cn(
        "ds-focus-inset grid h-10 cursor-default items-center gap-3 border-b border-ds-tint-neutral-border px-3 text-ds-ui outline-none select-none",
        selected ? "bg-ds-accent" : "hover:bg-ds-accent",
      )}
      style={{ gridTemplateColumns: FILE_TABLE_COLUMNS }}
    >
      <div role="gridcell" className="flex items-center" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <Checkbox aria-label={`Select ${entry.name}`} checked={selected} tabIndex={-1} onCheckedChange={onToggle} />
      </div>
      <div role="gridcell" className="flex min-w-0 items-center gap-2.5">
        <FileTile entry={entry} access={access} size={32} className="size-6 rounded-[6px] [&_svg]:size-3.5" />
        <span className="truncate font-medium text-ds-foreground" title={entry.name}>{entry.name}</span>
      </div>
      <div role="gridcell" className="truncate text-ds-ui-sm text-ds-muted-foreground">{kindLabel(entry)}</div>
      <div role="gridcell" className="text-right text-ds-ui-sm text-ds-muted-foreground tabular-nums">{formatEntrySize(entry)}</div>
      <div role="gridcell" className="truncate text-ds-ui-sm text-ds-muted-foreground tabular-nums">{formatModified(entry.modifiedAt, now)}</div>
      <div role="gridcell">
        {access === "own" ? <span className="text-ds-ui-sm text-ds-muted-foreground">{ACCESS_LABEL.own}</span> : <Badge variant={access === "shared" ? "info" : "neutral"}>{ACCESS_LABEL[access]}</Badge>}
      </div>
    </div>
  );
}
