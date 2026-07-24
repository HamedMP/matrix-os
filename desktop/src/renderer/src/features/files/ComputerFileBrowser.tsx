import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  Home,
  LayoutGrid,
  List,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, IconButton } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import {
  parseBrowserEntries,
  sortBrowserEntries,
  type BrowserEntry,
  type BrowserSortDirection,
  type BrowserSortKey,
} from "./browser-entries";
import { useBrowserViewPreference, type BrowserViewMode } from "./browser-view-preference";
import { FileGlyph, kindForEntry } from "./file-kind";
import { formatEntrySize, formatModified } from "./format";

type BrowserStatus = "loading" | "ready" | "error";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

// ArrowUp/ArrowDown in grid view move by a visual row. Columns are measured
// from the rendered tiles; jsdom (offsetWidth 0) and unmeasured layouts fall
// back to single-step movement.
function measureGridColumns(container: HTMLElement | null): number {
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

function ViewSwitcher({
  view,
  onChange,
}: {
  view: BrowserViewMode;
  onChange: (view: BrowserViewMode) => void;
}) {
  const options: Array<{ mode: BrowserViewMode; label: string; icon: typeof LayoutGrid }> = [
    { mode: "grid", label: "Grid view", icon: LayoutGrid },
    { mode: "list", label: "List view", icon: List },
  ];
  return (
    <div
      role="group"
      aria-label="View options"
      className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
      style={{ background: "var(--bg-hover)" }}
    >
      {options.map(({ mode, label, icon: Icon }) => {
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

function SortHeader({
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

export default function ComputerFileBrowser({
  compact = false,
  mode = "browse",
  onOpenFile,
  onChooseFolder,
}: {
  compact?: boolean;
  // "folder-picker" lists directories only, so picking a target folder never
  // competes with files. The default "browse" mode is unchanged.
  mode?: "browse" | "folder-picker";
  onOpenFile?: (path: string) => void;
  onChooseFolder?: (path: string) => void;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const view = useBrowserViewPreference((state) => state.view);
  const setView = useBrowserViewPreference((state) => state.setView);
  const [currentPath, setCurrentPath] = useState("");
  const [candidatePath, setCandidatePath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [status, setStatus] = useState<BrowserStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<BrowserSortKey>("name");
  const [sortDirection, setSortDirection] = useState<BrowserSortDirection>("asc");
  const requestGeneration = useRef(0);
  const entryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Listings belong to one computer/session. Derive the rendered view
  // synchronously from the scope they were loaded under, so a runtime switch
  // or replacement session never shows the previous owner's directory names or
  // lets stale rows fire onOpenFile/onChooseFolder against the new API.
  const browserScope = `${runtimeSlot}|${authGeneration}`;
  const [loadedScope, setLoadedScope] = useState(browserScope);
  const scoped = loadedScope === browserScope;
  const viewCurrentPath = scoped ? currentPath : "";
  const viewCandidatePath = scoped ? candidatePath : "";
  const viewSelectedPath = scoped ? selectedPath : null;
  const viewEntries = scoped
    ? (mode === "folder-picker" ? entries.filter((entry) => entry.type === "directory") : entries)
    : [];
  const viewStatus: BrowserStatus = scoped ? status : "loading";
  const viewError = scoped ? error : null;

  const sortedEntries = useMemo(
    () => sortBrowserEntries(viewEntries, sortKey, sortDirection),
    [viewEntries, sortKey, sortDirection],
  );

  const load = useCallback(async (path: string) => {
    if (!api) return;
    const generation = ++requestGeneration.current;
    setStatus("loading");
    setError(null);
    try {
      const response = await api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
      if (generation !== requestGeneration.current) return;
      setEntries(parseBrowserEntries(response.entries));
      setStatus("ready");
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setEntries([]);
      setStatus("error");
      setError(toUserMessage(err));
    }
  }, [api]);

  useEffect(() => {
    setLoadedScope(browserScope);
    setCurrentPath("");
    setCandidatePath("");
    setSelectedPath(null);
    void load("");
    return () => {
      requestGeneration.current += 1;
    };
  }, [browserScope, load]);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
    setCandidatePath(path);
    setSelectedPath(null);
    void load(path);
  }, [load]);

  const goUp = useCallback(() => {
    if (viewCurrentPath) navigate(parentPath(viewCurrentPath));
  }, [navigate, viewCurrentPath]);

  // Single click selects; files also open their preview immediately so the
  // browser/preview split behaves like a Finder column with Quick Look.
  const selectEntry = useCallback((entry: BrowserEntry, path: string) => {
    setSelectedPath(path);
    if (entry.type === "directory") setCandidatePath(path);
    else onOpenFile?.(path);
  }, [onOpenFile]);

  // Double-click or Enter "opens": directories navigate, files preview.
  const activateEntry = useCallback((entry: BrowserEntry, path: string) => {
    if (entry.type === "directory") navigate(path);
    else onOpenFile?.(path);
  }, [navigate, onOpenFile]);

  const focusEntry = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, sortedEntries.length - 1));
    entryRefs.current[clamped]?.focus();
  }, [sortedEntries.length]);

  const onEntryKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, entry: BrowserEntry, path: string, index: number) => {
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      goUp();
      return;
    }
    const step = view === "grid" ? measureGridColumns(gridRef.current) : 1;
    switch (event.key) {
      case "Enter":
        // Prevent the native button click so activation fires exactly once.
        event.preventDefault();
        activateEntry(entry, path);
        break;
      case "Backspace":
        event.preventDefault();
        goUp();
        break;
      case "ArrowDown":
        event.preventDefault();
        focusEntry(index + step);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusEntry(index - step);
        break;
      case "ArrowRight":
        if (view === "grid") {
          event.preventDefault();
          focusEntry(index + 1);
        }
        break;
      case "ArrowLeft":
        if (view === "grid") {
          event.preventDefault();
          focusEntry(index - 1);
        }
        break;
    }
  }, [activateEntry, focusEntry, goUp, view]);

  const toggleSort = useCallback((key: BrowserSortKey) => {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  }, [sortKey]);

  const crumbs = useMemo(() => {
    const segments = viewCurrentPath ? viewCurrentPath.split("/") : [];
    return segments.map((label, index) => ({ label, path: segments.slice(0, index + 1).join("/") }));
  }, [viewCurrentPath]);

  const chosenName = (viewCandidatePath.split("/").pop() || "Matrix home");
  const listColumns = compact ? "minmax(0,1fr) 72px 104px" : "minmax(0,1fr) 88px 140px";

  const renderEntryButton = (entry: BrowserEntry, index: number) => {
    const path = joinPath(viewCurrentPath, entry.name);
    const isCandidate = entry.type === "directory" && viewCandidatePath === path;
    const selected = viewSelectedPath === path || isCandidate;
    const shared = {
      key: `${entry.type}:${path}`,
      ref: (el: HTMLButtonElement | null) => {
        entryRefs.current[index] = el;
      },
      type: "button" as const,
      "aria-label": `Open ${entry.name}`,
      "aria-pressed": mode === "folder-picker" && entry.type === "directory" ? isCandidate : undefined,
      onClick: () => selectEntry(entry, path),
      onDoubleClick: () => {
        if (entry.type === "directory") navigate(path);
      },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => onEntryKeyDown(event, entry, path, index),
    };
    const glyphColor = entry.type === "directory" ? "var(--accent)" : "var(--text-tertiary)";
    const kind = kindForEntry(entry);

    if (view === "grid") {
      return (
        <button
          {...shared}
          data-grid-tile
          className="flex w-24 flex-col items-center gap-1.5 rounded-lg px-1.5 py-2.5 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          style={{ background: selected ? "var(--bg-selected)" : "transparent" }}
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
        {...shared}
        className="grid h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        style={{
          gridTemplateColumns: listColumns,
          background: selected ? "var(--bg-selected)" : "transparent",
          color: "var(--text-primary)",
        }}
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
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--border-subtle)" }}>
        <IconButton
          label="Up one level"
          className="shrink-0 disabled:opacity-40"
          disabled={!viewCurrentPath}
          onClick={goUp}
        >
          <ArrowUp size={13} />
        </IconButton>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            aria-label="Matrix home"
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
            style={{ color: viewCurrentPath ? "var(--text-secondary)" : "var(--text-primary)" }}
            onClick={() => navigate("")}
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
                style={{ color: crumb.path === viewCurrentPath ? "var(--text-primary)" : "var(--text-secondary)" }}
                onClick={() => navigate(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <ViewSwitcher view={view} onChange={setView} />
        <IconButton label="Refresh folder" className="shrink-0" onClick={() => void load(viewCurrentPath)}>
          <RefreshCw size={13} />
        </IconButton>
      </div>

      <div className={`${compact ? "h-52" : "min-h-0 flex-1"} overflow-y-auto p-1.5`}>
        {viewStatus === "loading" ? (
          <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading folder…</div>
        ) : viewStatus === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="text-sm" style={{ color: "var(--danger)" }}>{viewError}</span>
            <Button variant="subtle" onClick={() => void load(viewCurrentPath)}>Try again</Button>
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm" style={{ color: "var(--text-tertiary)" }}>
            <FolderOpen size={22} aria-hidden />
            <span>{mode === "folder-picker" ? "No subfolders here." : "This folder is empty."}</span>
          </div>
        ) : view === "grid" ? (
          <div ref={gridRef} className="flex flex-wrap content-start gap-1">
            {sortedEntries.map(renderEntryButton)}
          </div>
        ) : (
          <div>
            <div
              className="sticky top-0 z-10 grid items-center gap-2 border-b px-2 pb-1 text-[11px] font-medium"
              style={{
                gridTemplateColumns: listColumns,
                borderColor: "var(--border-subtle)",
                background: "var(--bg-surface)",
              }}
            >
              <SortHeader
                label="Name"
                sortLabel="Sort by name"
                active={sortKey === "name"}
                direction={sortDirection}
                onClick={() => toggleSort("name")}
              />
              <SortHeader
                label="Size"
                sortLabel="Sort by size"
                active={sortKey === "size"}
                direction={sortDirection}
                alignEnd
                onClick={() => toggleSort("size")}
              />
              <SortHeader
                label="Modified"
                sortLabel="Sort by modified"
                active={sortKey === "modified"}
                direction={sortDirection}
                onClick={() => toggleSort("modified")}
              />
            </div>
            <div className="grid grid-cols-1 gap-0.5 pt-0.5">
              {sortedEntries.map(renderEntryButton)}
            </div>
          </div>
        )}
      </div>

      {onChooseFolder ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
          <span className="min-w-0 truncate text-xs" style={{ color: "var(--text-secondary)" }} title={viewCandidatePath || "Matrix home"}>
            {viewCandidatePath || "Matrix home"}
          </span>
          <Button variant="primary" disabled={!viewCandidatePath} onClick={() => onChooseFolder(viewCandidatePath)}>
            Choose {chosenName}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
