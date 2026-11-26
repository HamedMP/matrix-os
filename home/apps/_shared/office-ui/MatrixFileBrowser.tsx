import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Select } from "./Fields";
import { FileThumb, type FileThumbKind } from "./FileThumb";
import { Skeleton } from "./Feedback";
import { cx } from "./internal";
import { ROW_ATTRIBUTE, useRovingRows } from "./roving";
import {
  MAX_BROWSER_ROWS,
  MAX_QUERY_LENGTH,
  breadcrumbTrail,
  browsableEntries,
  exactTime,
  filterEntries,
  hiddenSystemCount,
  parentDir,
  relativeTime,
  sortEntries,
  startDirCandidates,
  type Crumb,
  type StartFileEntry,
  type StartFolderMemory,
  type StartSort,
} from "./start-model";
import { errorCode, useTypedOpen, type TypedOpenState } from "./typed-open";

/** The part of `MatrixOS.files` the browser uses. */
export interface BrowserFiles {
  list(dir: string, options?: { limit?: number }): Promise<{ entries: StartFileEntry[]; truncated: boolean }>;
  /** Lets the browser check a typed file name before opening it, in a folder too large to list. */
  stat?(path: string): Promise<unknown>;
}

export interface MatrixFileBrowserProps {
  files: BrowserFiles;
  /** Extensions to list (".docx"); folders are always listed. */
  accept: readonly string[];
  onOpen: (path: string) => void;
  /** App name for messages ("Docs is not allowed to look in this folder."). */
  appName: string;
  /** What the files are called, for empty folders ("Word documents"). */
  fileNoun: string;
  kindOf: (entry: StartFileEntry) => { kind: FileThumbKind; tag?: string };
  /** Where browsing starts (default the home root). Ignored when `memory` is given. */
  initialDir?: string;
  /**
   * Remembers the folder the owner last used. Browsing then starts there,
   * else in `documents`, else at the home root, and each folder the owner
   * goes to is remembered.
   */
  memory?: StartFolderMemory;
  disabled?: boolean;
  /** Receives the search field, so a call to action can focus it. */
  searchRef?: RefObject<HTMLInputElement | null>;
  now?: number;
  className?: string;
}

type Listing =
  | { status: "loading"; dir: string }
  | { status: "ready"; dir: string; entries: StartFileEntry[]; truncated: boolean }
  | { status: "error"; dir: string; message: string };

/**
 * A folder that is gone, closed to the app or no longer a folder (now a file:
 * `invalid_request`), as opposed to one that failed to list this time.
 */
function isUnusableFolder(error: unknown): boolean {
  const code = errorCode(error);
  return code === "not_found" || code === "forbidden" || code === "invalid_request";
}

function listingMessage(error: unknown, appName: string): string {
  const code = errorCode(error);
  if (code === "forbidden") return `${appName} is not allowed to look in this folder.`;
  if (code === "not_found" || code === "invalid_request") return "This folder no longer exists.";
  return "This folder could not be listed. Try again in a moment.";
}

const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Last changed" },
] as const;

/**
 * The owner's Matrix home, one folder at a time: breadcrumbs, a name filter
 * for the folder, sorting, and only the folders and file types the app opens.
 * Clicking a folder enters it, clicking a file opens it. Up/Down move between
 * rows; Backspace goes up a folder. When a folder holds more than one listing
 * returns, the owner can open a left-out file or folder by typing its full name.
 */
export function MatrixFileBrowser({ files, accept, onOpen, appName, fileNoun, kindOf, initialDir = "", memory, disabled, searchRef, now, className }: MatrixFileBrowserProps) {
  // Null until the remembered folder has been read.
  const [dir, setDir] = useState<string | null>(memory ? null : initialDir);
  const [attempt, setAttempt] = useState(0);
  const [listing, setListing] = useState<Listing>({ status: "loading", dir: initialDir });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<StartSort>("name");
  const [showSystem, setShowSystem] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfterLoad = useRef(false);
  // Folders still to try while the browser looks for its starting folder.
  const fallbacks = useRef<string[]>([]);
  // The folder the owner chose to go to, remembered once it lists.
  const chosen = useRef<string | null>(null);
  // A string key, so an inline `accept` array does not list the folder again on every render.
  const acceptKey = accept.join(",");

  useEffect(() => {
    if (!memory || dir !== null) return;
    let live = true;
    void memory.read().then((remembered) => {
      if (!live) return;
      const [first = "", ...rest] = startDirCandidates(remembered);
      fallbacks.current = rest;
      setListing({ status: "loading", dir: first });
      setDir(first);
    });
    return () => {
      live = false;
    };
  }, [memory, dir]);

  useEffect(() => {
    if (dir === null) return;
    let live = true;
    files.list(dir).then(
      (result) => {
        if (!live) return;
        fallbacks.current = [];
        if (chosen.current === dir) {
          chosen.current = null;
          void memory?.write(dir);
        }
        setListing({ status: "ready", dir, entries: result.entries, truncated: result.truncated });
      },
      (error: unknown) => {
        if (!live) return;
        const next = isUnusableFolder(error) ? fallbacks.current.shift() : undefined;
        if (next !== undefined) {
          setListing({ status: "loading", dir: next });
          setDir(next);
          return;
        }
        chosen.current = null;
        console.warn(`[${appName.toLowerCase()}] could not list a folder`, errorCode(error) ?? (error instanceof Error ? error.name : typeof error));
        setListing({ status: "error", dir, message: listingMessage(error, appName) });
      },
    );
    return () => {
      live = false;
    };
  }, [files, dir, attempt, appName, memory]);

  const visible = useMemo(() => {
    if (listing.status !== "ready") return { entries: [] as StartFileEntry[], system: 0 };
    return {
      entries: browsableEntries(listing.dir, listing.entries, acceptKey.split(","), { showSystem }),
      system: hiddenSystemCount(listing.dir, listing.entries),
    };
  }, [listing, acceptKey, showSystem]);
  const shown = useMemo(() => {
    const matches = sortEntries(filterEntries(visible.entries, query), sort);
    return { rows: matches.slice(0, MAX_BROWSER_ROWS), total: matches.length };
  }, [visible, query, sort]);
  const roving = useRovingRows(shown.rows.map((entry) => entry.path));
  const typed = useTypedOpen({
    files,
    listing,
    query,
    acceptKey,
    disabled,
    appName,
    onFile: onOpen,
    onFolder: (path) => goTo(path, true),
  });

  // A layout effect, so focus lands in the same commit that draws the rows.
  useLayoutEffect(() => {
    if (listing.status !== "loading" && focusAfterLoad.current) {
      focusAfterLoad.current = false;
      listRef.current?.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}]`)?.focus();
    }
  }, [listing]);

  const changeQuery = (next: string) => {
    typed.reset();
    setQuery(next);
  };
  const goTo = (path: string, moveFocus: boolean) => {
    focusAfterLoad.current = moveFocus;
    fallbacks.current = [];
    chosen.current = path;
    changeQuery("");
    setListing({ status: "loading", dir: path });
    setDir(path);
  };
  const retry = () => {
    if (dir === null) return;
    setListing({ status: "loading", dir });
    setAttempt((value) => value + 1);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "Backspace" && dir !== null && dir !== "") {
      event.preventDefault();
      goTo(parentDir(dir), true);
      return;
    }
    roving.onKeyDown(event);
  };

  const crumbs = breadcrumbTrail(dir ?? "");
  const loading = listing.status === "loading";
  const clock = now ?? Date.now();
  return (
    <div className={cx("oui-browser", className)}>
      <div className="oui-browser__bar">
        <Crumbs trail={crumbs} onGo={(path) => goTo(path, true)} />
        <div className="oui-browser__tools">
          <SearchField
            inputRef={searchRef}
            query={query}
            onQuery={changeQuery}
            onSubmit={typed.open}
            onEnterList={() => {
              const first = listRef.current?.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}]`);
              first?.focus();
              return first !== null && first !== undefined;
            }}
          />
          <Select className="oui-browser__sort" label="Sort by" hideLabel value={sort} options={SORT_OPTIONS} onChange={(value) => setSort(value === "modified" ? "modified" : "name")} />
        </div>
      </div>
      <div className="oui-browser__body" aria-busy={loading || undefined}>
        <BrowserStatus
          listing={listing}
          entries={visible.entries.length}
          matches={shown.total}
          query={query}
          truncated={typed.truncated}
          fileNoun={fileNoun}
          onRetry={retry}
          onUp={dir === null || dir === "" ? null : () => goTo(parentDir(dir), true)}
          onClearQuery={() => changeQuery("")}
        />
        {shown.rows.length > 0 && (
          <ul ref={listRef} className="oui-browser__list" aria-label="Folders and files" onKeyDown={onListKeyDown}>
            {shown.rows.map((entry) => {
              const folder = entry.kind === "dir";
              const look = folder ? { kind: "folder" as const } : kindOf(entry);
              const when = folder ? "" : relativeTime(entry.modifiedAt, clock);
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={cx("oui-browser__row", folder && "is-folder")}
                    {...{ [ROW_ATTRIBUTE]: "" }}
                    tabIndex={roving.current === entry.path ? 0 : -1}
                    aria-label={folder ? `Folder ${entry.name}` : `${entry.name}${when ? `, changed ${when.toLowerCase()}` : ""}`}
                    disabled={disabled && !folder}
                    onFocus={() => roving.focusRow(entry.path)}
                    onClick={() => (folder ? goTo(entry.path, true) : onOpen(entry.path))}
                  >
                    <FileThumb kind={look.kind} tag={look.tag} size="sm" />
                    <span className="oui-browser__name">{entry.name}</span>
                    {folder ? (
                      <svg className="oui-browser__enter" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <span className="oui-browser__when" title={exactTime(entry.modifiedAt)}>
                        {when}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {listing.status === "ready" && shown.total > shown.rows.length && <p className="oui-browser__note">{`Showing ${shown.rows.length} of ${shown.total}. Filter to find the rest.`}</p>}
      <TypedOpenNote typed={typed} disabled={disabled} />
      {visible.system > 0 && (
        <p className="oui-browser__note oui-browser__system">
          <span>{showSystem ? "Matrix system folders are shown." : "Matrix system folders are hidden."}</span>
          <button type="button" className="oui-browser__system-toggle" aria-pressed={showSystem} onClick={() => setShowSystem((value) => !value)}>
            {showSystem ? "Hide system folders" : "Show system folders"}
          </button>
        </p>
      )}
    </div>
  );
}

/** Says the listing left entries out and offers to open the typed name. */
function TypedOpenNote({ typed, disabled }: { typed: TypedOpenState; disabled: boolean | undefined }) {
  if (!typed.truncated) return null;
  return (
    <div className="oui-browser__note oui-browser__typed">
      <p>This folder holds more items than can be listed. Type the full name of a file or folder to open it.</p>
      {typed.target && typed.open && (
        <button type="button" className="oui-button" disabled={disabled || typed.busy} onClick={typed.open}>
          Open “{typed.target.name}”
        </button>
      )}
      <span role="status">{typed.message}</span>
    </div>
  );
}

function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Crumbs({ trail, onGo }: { trail: readonly Crumb[]; onGo: (path: string) => void }) {
  return (
    <nav className="oui-browser__crumbs" aria-label="Folder path">
      <ol>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={crumb.path}>
              {index > 0 && <Chevron className="oui-browser__sep" />}
              <button type="button" className={cx("oui-browser__crumb", last && "is-current")} aria-current={last ? "location" : undefined} onClick={() => !last && onGo(crumb.path)}>
                {crumb.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface SearchFieldProps {
  inputRef?: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  /** Moves focus to the first row; false when there is none. */
  onEnterList: () => boolean;
  /** Runs on Enter, when the query names something to open. */
  onSubmit?: () => void;
}

function SearchField({ inputRef, query, onQuery, onEnterList, onSubmit }: SearchFieldProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && onEnterList()) event.preventDefault();
    else if (event.key === "Enter" && onSubmit) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      onQuery("");
    }
  };
  return (
    <label className="oui-browser__search">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="oui-sr-only">Filter this folder by name</span>
      <input
        ref={inputRef}
        type="search"
        className="oui-input"
        placeholder="Filter this folder"
        value={query}
        maxLength={MAX_QUERY_LENGTH}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}

interface BrowserStatusProps {
  listing: Listing;
  /** Entries the folder shows before the filter. */
  entries: number;
  /** Entries that match the filter. */
  matches: number;
  query: string;
  /** The listing left entries out, so a miss here is not a miss in the folder. */
  truncated: boolean;
  fileNoun: string;
  onRetry: () => void;
  /** Goes to the parent folder; null at the home root. */
  onUp: (() => void) | null;
  onClearQuery: () => void;
}

/** Loading, failure, empty folder and no-match states; nothing once rows are shown. */
function BrowserStatus({ listing, entries, matches, query, truncated, fileNoun, onRetry, onUp, onClearQuery }: BrowserStatusProps) {
  if (listing.status === "loading") {
    return (
      <div className="oui-browser__loading" role="status">
        <span className="oui-sr-only">Loading folder</span>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="oui-browser__ghost">
            <Skeleton width={26} height={32} radius={4} />
            <Skeleton width={`${46 - row * 7}%`} height={12} />
          </div>
        ))}
      </div>
    );
  }
  if (listing.status === "error") {
    return (
      <div role="alert" className="oui-browser__notice">
        <p>{listing.message}</p>
        <button type="button" className="oui-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (entries === 0) {
    return (
      <div className="oui-browser__notice">
        <p>No folders or {fileNoun} here.</p>
        {onUp && (
          <button type="button" className="oui-button" onClick={onUp}>
            Up one folder
          </button>
        )}
      </div>
    );
  }
  if (matches > 0) return null;
  return (
    <div className="oui-browser__notice" role="status">
      <p>{truncated ? `Nothing listed here matches “${query.trim()}”.` : `Nothing in this folder matches “${query.trim()}”.`}</p>
      <button type="button" className="oui-button" onClick={onClearQuery}>
        Clear filter
      </button>
    </div>
  );
}
