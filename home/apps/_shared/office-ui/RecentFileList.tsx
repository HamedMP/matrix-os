import { useState, type KeyboardEvent, type ReactNode } from "react";
import { FileThumb, type FileThumbKind } from "./FileThumb";
import { cx } from "./internal";
import { ROW_ATTRIBUTE, useRovingRows } from "./roving";
import { exactTime, folderLabel, relativeTime } from "./start-model";

export interface RecentEntry {
  path: string;
  name: string;
  /** ISO time the file was last opened or saved. */
  openedAt: string;
}

export interface RecentFileListProps {
  /** Accessible name of the list ("Recent documents"). */
  label: string;
  items: readonly RecentEntry[];
  onOpen: (path: string) => void;
  /** Forgets an entry; the list keeps it until the promise settles. */
  onRemove: (path: string) => Promise<void> | void;
  /** The typed page shown for an entry. */
  kindOf: (entry: RecentEntry) => { kind: FileThumbKind; tag?: string };
  /** Path being opened, marked busy. */
  opening?: string | null;
  disabled?: boolean;
  /** Shown when there are no entries. */
  empty: ReactNode;
  /** Clock for the relative times, for tests. */
  now?: number;
  className?: string;
}

/**
 * Recently opened files, newest first: a typed page, the name, its folder and
 * when it was last opened. Up/Down move between rows, Enter opens, Delete or
 * the row's remove button forgets an entry (Right moves to that button).
 */
export function RecentFileList({ label, items, onOpen, onRemove, kindOf, opening = null, disabled, empty, now, className }: RecentFileListProps) {
  const roving = useRovingRows(items.map((item) => item.path));
  const [removing, setRemoving] = useState<readonly string[]>([]);
  if (items.length === 0) return <>{empty}</>;
  const clock = now ?? Date.now();
  const pendingRemoval = new Set(removing);

  const remove = (path: string, row: HTMLElement | null) => {
    if (pendingRemoval.has(path)) return;
    // Keep focus in the list: on the next row, else the previous one.
    const li = row?.closest("li");
    const neighbour = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}]`) ?? null;
    setRemoving((list) => [...list, path]);
    void Promise.resolve(onRemove(path)).finally(() => {
      setRemoving((list) => list.filter((entry) => entry !== path));
      neighbour?.focus();
    });
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, path: string) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(path, event.currentTarget);
    } else if (event.key === "ArrowRight") {
      const button = event.currentTarget.parentElement?.querySelector<HTMLElement>(".oui-recent__remove");
      if (button) {
        event.preventDefault();
        button.focus();
      }
    }
  };

  return (
    <ul className={cx("oui-recent", className)} aria-label={label} onKeyDown={roving.onKeyDown}>
      {items.map((item) => {
        const look = kindOf(item);
        const busy = opening === item.path;
        const when = relativeTime(item.openedAt, clock);
        const folder = folderLabel(item.path);
        return (
          <li key={item.path} className={cx("oui-recent__item", pendingRemoval.has(item.path) && "is-removing")}>
            <button
              type="button"
              className="oui-recent__open"
              {...{ [ROW_ATTRIBUTE]: "" }}
              tabIndex={roving.current === item.path ? 0 : -1}
              aria-label={`${item.name}, in ${folder}${when ? `, opened ${when.toLowerCase()}` : ""}`}
              aria-keyshortcuts="Delete"
              aria-busy={busy || undefined}
              disabled={disabled}
              onFocus={() => roving.focusRow(item.path)}
              onClick={() => onOpen(item.path)}
              onKeyDown={(event) => onRowKeyDown(event, item.path)}
            >
              <FileThumb kind={look.kind} tag={look.tag} />
              <span className="oui-recent__text">
                <span className="oui-recent__name">{item.name}</span>
                <span className="oui-recent__folder">{folder}</span>
              </span>
              <span className="oui-recent__when" title={exactTime(item.openedAt)}>
                {busy ? "Opening…" : when}
              </span>
            </button>
            <button
              type="button"
              className="oui-icon-button oui-recent__remove"
              tabIndex={-1}
              aria-label={`Remove ${item.name} from recent`}
              title="Remove from recent (Delete)"
              disabled={disabled || pendingRemoval.has(item.path)}
              onClick={(event) => remove(item.path, event.currentTarget.parentElement?.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}]`) ?? null)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  event.currentTarget.parentElement?.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}]`)?.focus();
                }
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
