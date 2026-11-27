import { FilePlus, FolderOpen, SearchX, Upload } from "lucide-react";
import { useMemo, type RefObject } from "react";
import { Button, Icon } from "../../../design/ds";
import { isManagedBrowserPath, type BrowserEntry, type BrowserSortDirection, type BrowserSortKey } from "../browser-entries";
import { FileCard } from "./FileCard";
import { FileGrid, FileGridSection } from "./FileGrid";
import { FileRow, FileTable } from "./FileTable";
import type { FilesView } from "./FilesHeader";
import { clearSelection, headerCheckState, selectAll } from "./selection-model";
import type { useEntryNavigation } from "./use-entry-navigation";
import type { ListingStatus } from "./use-folder-listing";

type EntryNavigation = ReturnType<typeof useEntryNavigation>;

/** UX-guide empty state: icon tile, Bricolage headline, description, actions. */
function EmptyState({ icon, title, description, children }: { icon: typeof FolderOpen; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-lg border border-ds-tint-neutral-border bg-ds-tint-neutral-fill text-ds-tint-neutral-text">
        <Icon icon={icon} size="lg" />
      </span>
      <h3 className="mt-2 font-ds-heading text-[20px] leading-7 font-medium text-ds-foreground">{title}</h3>
      <p className="max-w-80 text-ds-ui-sm text-ds-muted-foreground">{description}</p>
      {children ? <div className="mt-3 flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** Empty folder or a filter with no matches, each with its next step. */
function FolderEmptyState({ filterActive, onUpload, onNewFile, onClearFilter }: { filterActive: boolean; onUpload?: () => void; onNewFile?: () => void; onClearFilter: () => void }) {
  if (filterActive) {
    return (
      <EmptyState icon={SearchX} title="No matches" description="Nothing in this folder matches the filter. Try a different name.">
        <Button variant="secondary" size="sm" onClick={onClearFilter}>Clear filter</Button>
      </EmptyState>
    );
  }
  const writable = Boolean(onUpload || onNewFile);
  return (
    <EmptyState
      icon={FolderOpen}
      title="This folder is empty"
      description={writable ? "Upload files or create a file to get started." : "Matrix OS manages this folder. Files appear here when Matrix adds them."}
    >
      {onUpload ? <Button variant="secondary" size="sm" onClick={onUpload}><Icon icon={Upload} size="sm" />Upload files</Button> : null}
      {onNewFile ? <Button variant="primary" size="sm" onClick={onNewFile}><Icon icon={FilePlus} size="sm" />New file</Button> : null}
    </EmptyState>
  );
}

/** The body of a folder: loading, error, empty, the list table, or the grid sections. */
export function FolderContent({
  title,
  status,
  error,
  onRetry,
  entries,
  order,
  filterActive,
  view,
  nav,
  sortKey,
  sortDirection,
  onSort,
  gridRef,
  onDropFiles,
  onUpload,
  onNewFile,
  onClearFilter,
}: {
  title: string;
  status: ListingStatus;
  error: string | null;
  onRetry: () => void;
  entries: readonly BrowserEntry[];
  order: readonly string[];
  filterActive: boolean;
  view: FilesView;
  nav: EntryNavigation;
  sortKey: BrowserSortKey;
  sortDirection: BrowserSortDirection;
  onSort: (key: BrowserSortKey) => void;
  gridRef: RefObject<HTMLDivElement | null>;
  onDropFiles: (files: File[], destination: string) => void;
  /** Empty-state actions; omitted in read-only folders. */
  onUpload?: () => void;
  onNewFile?: () => void;
  onClearFilter: () => void;
}) {
  const selected = useMemo(() => new Set(nav.selection.selected), [nav.selection.selected]);

  if (status === "loading") return <p className="py-16 text-center text-ds-ui-sm text-ds-muted-foreground">Loading folder…</p>;
  if (status === "error") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p role="alert" className="text-ds-ui text-ds-foreground">{error}</p>
        <Button variant="secondary" onClick={onRetry}>Try again</Button>
      </div>
    );
  }
  if (entries.length === 0) return <FolderEmptyState filterActive={filterActive} onUpload={onUpload} onNewFile={onNewFile} onClearFilter={onClearFilter} />;

  const entryProps = (entry: BrowserEntry, index: number) => {
    const entryPath = order[index]!;
    const managed = isManagedBrowserPath(entryPath);
    return {
      entry,
      path: entryPath,
      access: managed ? ("managed" as const) : ("own" as const),
      selected: selected.has(entryPath),
      focusable: index === nav.focusIndex,
      handlers: nav.handlersFor(index),
      attachmentPath: entry.type === "file" && !managed ? entryPath : undefined,
      onDropFiles: entry.type === "directory" && !managed ? (files: File[]) => onDropFiles(files, entryPath) : undefined,
    };
  };
  const label = `Contents of ${title}`;

  if (view === "list") {
    return (
      <FileTable
        label={label}
        headerChecked={headerCheckState(nav.selection, order)}
        onHeaderCheckedChange={(next) => nav.setSelection(next ? selectAll(order) : clearSelection())}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={onSort}
      >
        {entries.map((entry, index) => (
          <FileRow key={order[index]} {...entryProps(entry, index)} onToggle={() => nav.toggle(index)} rowRef={(el) => { nav.refs.current[index] = el; }} />
        ))}
      </FileTable>
    );
  }

  const folders = entries.filter((entry) => entry.type === "directory").length;
  return (
    <FileGrid label={label}>
      {folders > 0 ? (
        <FileGridSection title="Folders" count={folders} gridRef={gridRef}>
          {entries.slice(0, folders).map((entry, index) => <FileCard key={order[index]} {...entryProps(entry, index)} cardRef={(el) => { nav.refs.current[index] = el; }} />)}
        </FileGridSection>
      ) : null}
      {entries.length > folders ? (
        <FileGridSection title="Files" count={entries.length - folders} gridRef={folders === 0 ? gridRef : undefined}>
          {entries.slice(folders).map((entry, offset) => {
            const index = folders + offset;
            return <FileCard key={order[index]} {...entryProps(entry, index)} cardRef={(el) => { nav.refs.current[index] = el; }} />;
          })}
        </FileGridSection>
      ) : null}
    </FileGrid>
  );
}
