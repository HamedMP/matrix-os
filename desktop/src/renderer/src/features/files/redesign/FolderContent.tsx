import { FolderOpen } from "lucide-react";
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
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <Icon icon={FolderOpen} size="lg" className="text-ds-muted-foreground" />
        <p className="text-ds-ui text-ds-muted-foreground">{filterActive ? "No files match this filter." : "This folder is empty."}</p>
      </div>
    );
  }

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
