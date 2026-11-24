import type { KeyboardEvent, MouseEvent, Ref } from "react";
import { Badge } from "../../../design/ds";
import { cn } from "../../../lib/cn";
import type { BrowserEntry } from "../browser-entries";
import { entryDragProps } from "./entry-drag";
import { entryMeta, type FolderAccess } from "./file-presentation";
import { FileTile } from "./FileTile";

export interface EntryHandlers {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onFocus?: () => void;
}

/**
 * One folder or file in the grid: a 32px tinted tile, a one-line name and a meta
 * line. Lives inside a listbox (FileGrid), so it is an option that reports its
 * selection; the full name is in the tooltip-style title when it truncates.
 */
export function FileCard({
  entry,
  path,
  access = "own",
  meta,
  selected,
  focusable,
  handlers,
  cardRef,
  attachmentPath,
  onDropFiles,
}: {
  entry: BrowserEntry;
  path: string;
  access?: FolderAccess;
  /** Overrides the default "4 items" / "PDF · 2.4 MB" line (Recent uses "Edited 2 Nov"). */
  meta?: string;
  selected: boolean;
  focusable: boolean;
  handlers: EntryHandlers;
  cardRef?: Ref<HTMLDivElement>;
  attachmentPath?: string;
  onDropFiles?: (files: File[]) => void;
}) {
  return (
    <div
      ref={cardRef}
      role="option"
      aria-selected={selected}
      aria-label={entry.name}
      tabIndex={focusable ? 0 : -1}
      data-files-entry-path={path}
      data-files-card
      {...entryDragProps<HTMLDivElement>({ attachmentPath, onDropFiles })}
      onClick={handlers.onClick}
      onDoubleClick={handlers.onDoubleClick}
      onKeyDown={handlers.onKeyDown}
      onFocus={handlers.onFocus}
      className={cn(
        "ds-focus group flex h-[60px] min-w-0 cursor-default items-center gap-3 rounded-lg border px-3 font-ds-sans outline-none select-none",
        "transition-colors duration-[120ms]",
        selected ? "border-ds-border-strong bg-ds-accent-strong" : "border-ds-tint-neutral-border bg-ds-card hover:bg-ds-accent-strong",
      )}
    >
      <FileTile entry={entry} access={access} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ds-ui font-medium text-ds-foreground" title={entry.name}>{entry.name}</span>
          {access === "shared" ? <Badge variant="info">Shared</Badge> : null}
          {access === "managed" ? <Badge>Managed</Badge> : null}
        </span>
        <span className="truncate text-ds-ui-xs text-ds-muted-foreground">{meta ?? (access === "managed" ? "Read-only" : entryMeta(entry))}</span>
      </span>
    </div>
  );
}
