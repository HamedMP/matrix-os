import { Archive, ArchiveRestore, Check, ChevronRight, Trash2 } from "lucide-react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { Badge, Button, isAcceptedProjectOwnedByRail } from "@matrix-os/ui";
import { Folder, MessageSquare, Search, UsersIcon, X } from "@renderer/lib/hugeicons";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Dialog } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import type { Project } from "../../stores/board";
import { sharedItemContext, sharedItemLabel, useWorkSharedDiscovery } from "./use-work-shared-discovery";
import { buildWorkRailSearchResults } from "./work-rail-model";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";

function archivedDateLabel(record: ChatNavigationRecord): string {
  const date = new Date(record.chat.archivedAt ?? record.chat.updatedAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (date >= today) return "today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= yesterday) return "yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function WorkSearchField({ query, disabled, listboxId, selectedOptionId, searchInputRef, onChange, onMove, onSelect, onClose, onRestore }: {
  query: string; disabled: boolean; listboxId: string; selectedOptionId?: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onChange(value: string): void; onMove(offset: number): void; onSelect(): void; onClose(): void; onRestore?(): void;
}) {
  return (
        <div className="chat-search-field flex h-12 items-center gap-2 border-b px-4" style={{ borderColor: "var(--border-default)" }}>
          <Search size={16} aria-hidden style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={searchInputRef}
            type="text"
            role="searchbox"
            aria-label="Search chats"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-activedescendant={selectedOptionId}
            autoFocus
            value={query}
            maxLength={200}
            disabled={disabled}
            className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-sm shadow-none outline-none ring-0 focus:border-0 focus:ring-0"
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              borderStyle: "none",
              borderWidth: 0,
              borderRadius: 0,
              boxShadow: "none",
              outline: "none",
              color: "var(--text-primary)",
            }}
            placeholder="Search chats, projects and files"
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r" && onRestore) {
                event.preventDefault();
                onRestore();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                onMove(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                onMove(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                onSelect();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <button
            type="button"
            aria-label="Clear Chat search"
            disabled={disabled}
            title="Clear Chat search"
            className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)]"
            onClick={() => {
              onChange("");
              searchInputRef.current?.focus();
            }}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
  );
}

function SearchArchiveDeleteDialog({ target, busy, error, onCancel, onConfirm }: {
  target: ChatNavigationRecord | null; busy: boolean; error?: string | null; onCancel(): void; onConfirm(): void;
}) {
  const buttonStyle = { fontFamily: "inherit", height: 36, padding: "0 14px", borderRadius: 8, fontSize: 14, lineHeight: "20px", fontWeight: 500 };
  return <Dialog open={Boolean(target)} onClose={() => { if (!busy) onCancel(); }} title="Delete archived chats?" role="alertdialog" width={420} placement="center">
    <div className="desktop-chat-design" style={{ padding: "24px 24px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 600, lineHeight: "20px", margin: 0 }}>Delete “{target?.chat.title}” forever?</h2>
      <p style={{ color: "var(--chat-muted)" }}>Its messages are deleted too. You can't undo this.</p>
      {error ? <p role="alert" style={{ color: "var(--chat-danger)" }}>{error}</p> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 16 }}>
        <Button variant="secondary" size="sm" style={buttonStyle} disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="destructive" size="sm" style={buttonStyle} disabled={busy} onClick={onConfirm}>Delete forever</Button>
      </div>
    </div>
  </Dialog>;
}

export function WorkRailSearchDialog(props: Parameters<typeof WorkRailSearchDialogContent>[0]) {
  const userId = useConnection(state => state.userId);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  return <WorkRailSearchDialogContent key={JSON.stringify([userId, runtimeSlot, authGeneration])} {...props}/>;
}

function WorkRailSearchDialogContent({
  open,
  centerX,
  records,
  client,
  projects,
  status,
  onClose,
  onSelect,
  onSelectProject,
  onOpenShared,
  onArchiveChanged,
  onArchiveRestored,
  onOpenArchivedList,
}: {
  open: boolean;
  centerX?: number;
  records: readonly ChatNavigationRecord[];
  client?: CanonicalChatClient | null;
  projects: readonly Project[];
  status: "idle" | "loading" | "ready" | "error";
  onClose: () => void;
  onSelect: (record: ChatNavigationRecord, project?: Project) => void;
  onSelectProject?: (project: Project) => void;
  onOpenShared?: () => void;
  onArchiveChanged?: () => void;
  onArchiveRestored?: (record: CanonicalChatRecord) => void;
  onOpenArchivedList?: () => void;
}) {
  const userId = useConnection(state => state.userId);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const actionScope = useMemo(() => ({ client, userId, runtimeSlot, authGeneration, open }), [client, userId, runtimeSlot, authGeneration, open]);
  const actionScopeRef = useRef<typeof actionScope | null>(actionScope);
  useLayoutEffect(() => { actionScopeRef.current = actionScope; return () => { actionScopeRef.current = null; }; }, [actionScope]);
  const [filter, setFilter] = useState<"All" | "Chats" | "Projects" | "Shared" | "Archived">("All");
  const organizationStatus = useConnection(state => state.organizationStatus);
  const activeFilter = organizationStatus === "none" && filter === "Shared" ? "All" : filter;
  const shared = useWorkSharedDiscovery(open && organizationStatus !== "none");
  const [query, setQuery] = useState("");
  const readScope = useMemo(() => ({ actionScope, activeFilter, query }), [actionScope, activeFilter, query]);
  const readScopeRef = useRef<typeof readScope | null>(readScope);
  useLayoutEffect(() => { readScopeRef.current = readScope; return () => { readScopeRef.current = null; }; }, [readScope]);
  const [resultScope, setResultScope] = useState(readScope);
  const [serverRecordsState, setServerRecords] = useState<ChatNavigationRecord[] | null>(null);
  const [serverCursorState, setServerCursor] = useState<string | null>(null);
  const serverRecords = resultScope === readScope ? serverRecordsState : null;
  const serverCursor = resultScope === readScope ? serverCursorState : null;
  const requestGeneration = useRef(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [deletion, setDeletion] = useState<{ scope: typeof actionScope; record: ChatNavigationRecord } | null>(null);
  const deleteTarget = deletion?.scope === actionScope ? deletion.record : null;
  const [archiveAction, setArchiveAction] = useState<{ scope: typeof actionScope; phase: "idle" | "pending" | "failed"; error?: string }>({ scope: actionScope, phase: "idle" });
  const archiveActionBusy = archiveAction.scope === actionScope && archiveAction.phase === "pending";
  const archiveActionError = archiveAction.scope === actionScope ? archiveAction.error : null;
  const mutationAttempt = useRef(0);
  const archiveRevision = useRef(0);
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    setResultScope(readScope);
    if (!open || !client || (activeFilter !== "Archived" && (!query.trim() || activeFilter === "Projects" || activeFilter === "Shared"))) {
      setServerRecords(null);
      setServerCursor(null);
      setSearchError(null);
      setSearchLoading(false);
      return () => { requestGeneration.current++; };
    }
    setServerRecords(null);
    setServerCursor(null);
    setSearchLoading(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      const request = activeFilter === "Archived" && !query.trim()
        ? client.list({ lifecycle: "archived", limit: 50 })
        : client.search(query, { lifecycle: activeFilter === "Archived" ? "archived" : "active", limit: 50 });
      void request.then(page => {
        if (requestGeneration.current === generation && readScopeRef.current === readScope) { setServerRecords(page.items); setServerCursor(page.nextCursor ?? null); }
      }).catch((error: unknown) => {
        console.warn("[work] Chat search failed:", error instanceof Error ? error.name : "UnknownError");
        if (requestGeneration.current === generation && readScopeRef.current === readScope) setSearchError("Chats could not be searched. Try again.");
      }).finally(() => { if (requestGeneration.current === generation && readScopeRef.current === readScope) setSearchLoading(false); });
    }, query.trim() ? 180 : 0);
    return () => { requestGeneration.current++; window.clearTimeout(timer); };
  }, [readScope, open, client, activeFilter, query]);
  const loadMore = async () => {
    if (!client || !serverCursor || searchLoading) return;
    const generation = requestGeneration.current;
    const revision = archiveRevision.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const page = activeFilter === "Archived" && !query.trim()
        ? await client.list({ lifecycle: "archived", limit: 50, cursor: serverCursor })
        : await client.search(query, { lifecycle: activeFilter === "Archived" ? "archived" : "active", limit: 50, cursor: serverCursor });
      if (requestGeneration.current !== generation || readScopeRef.current !== readScope || archiveRevision.current !== revision) return;
      setServerRecords(current => [...(current ?? []), ...page.items.filter(item => !current?.some(row => row.chat.id === item.chat.id))].slice(-500));
      setServerCursor(page.nextCursor ?? null);
    } catch (error: unknown) {
      console.warn("[work] More chat results failed:", error instanceof Error ? error.name : "UnknownError");
      if (requestGeneration.current === generation && readScopeRef.current === readScope) setSearchError("More chats could not be loaded. Try again.");
    } finally { if (requestGeneration.current === generation && readScopeRef.current === readScope) setSearchLoading(false); }
  };
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const remote = serverRecords ? buildWorkRailSearchResults(serverRecords, projects, "", 500) : [];
    const local = activeFilter === "Archived" ? [] : buildWorkRailSearchResults(records, projects, query);
    const seen = new Set<string>();
    const chats = activeFilter === "All" || activeFilter === "Chats" || activeFilter === "Archived"
      ? [...remote, ...local].filter(result => !seen.has(result.record.chat.id) && Boolean(seen.add(result.record.chat.id)))
        .map(result => ({ kind: "chat" as const, ...result, label: result.record.chat.title, key: `chat:${result.record.chat.id}` })) : [];
    const projectResults = (activeFilter === "All" || activeFilter === "Projects") && onSelectProject
      ? projects.filter(project => !normalized || `${project.name}
${project.slug}`.toLocaleLowerCase().includes(normalized)).map(project => ({ kind: "project" as const, project, label: project.name, contextLabel: "Project", key: `project:${project.id ?? project.slug}` })) : [];
    const sharedResults = activeFilter === "All" || activeFilter === "Shared"
      ? shared.items.filter(item => !isAcceptedProjectOwnedByRail(item))
        .filter(item => !normalized || `${sharedItemLabel(item)}
${sharedItemContext(item)}`.toLocaleLowerCase().includes(normalized)).map(item => ({ kind: "shared" as const, item, label: sharedItemLabel(item), contextLabel: sharedItemContext(item), key: item.status === "invited" ? `invite:${item.invitationId}` : `shared:${item.scopeId}` })) : [];
    return [...chats, ...projectResults, ...sharedResults];
  }, [activeFilter, projects, query, records, serverRecords, shared.items, onSelectProject]);
  useEffect(() => {
    setSelectedIndex((current) => (
      results.length === 0 ? 0 : Math.min(current, results.length - 1)
    ));
  }, [results.length]);
  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, results, selectedIndex]);

  const close = () => {
    setQuery("");
    setFilter("All");
    setSelectedIndex(0);
    mutationAttempt.current++;
    setDeletion(null);
    onClose();
  };
  const select = (index: number) => {
    const result = results[index];
    if (!result) return;
    if (activeFilter === "Archived") { onOpenArchivedList?.(); close(); return; }
    if (result.kind === "chat") onSelect(result.record, result.project);
    else if (result.kind === "project") onSelectProject?.(result.project);
    else { onOpenShared?.(); onClose(); }
    setQuery("");
    setSelectedIndex(0);
  };
  const updateQuery = (next: string) => {
    setQuery(next);
    setDeletion(null);
    setSelectedIndex(0);
  };
  const moveSelection = (offset: number) => {
    if (results.length === 0) return;
    setSelectedIndex((current) => (current + offset + results.length) % results.length);
  };
  const applyArchivedAction = async (action: "restore" | "delete", record: ChatNavigationRecord) => {
    if (!client || archiveActionBusy || !open || actionScopeRef.current !== actionScope) return;
    const attempt = ++mutationAttempt.current;
    const isCurrent = () => actionScopeRef.current === actionScope && mutationAttempt.current === attempt;
    setArchiveAction({ scope: actionScope, phase: "pending" });
    let completed = false;
    let restored: CanonicalChatRecord | undefined;
    let error: string | undefined;
    try {
      if (action === "restore") restored = await client.updateLifecycle(record.chat.id, { baseRevision: record.chat.revision, lifecycle: "active" });
      else await client.delete(record.chat.id, canonicalChatRequestId());
      completed = true;
    } catch (cause: unknown) {
      console.warn("[work] Archived chat action failed:", cause instanceof Error ? cause.name : "UnknownError");
      error = action === "restore" ? "The chat could not be restored. Try again." : "The chat could not be deleted. Try again.";
    } finally {
      if (isCurrent()) {
        setArchiveAction({ scope: actionScope, phase: error ? "failed" : "idle", error });
        if (completed) {
          archiveRevision.current++;
          setServerRecords(current => current?.filter(row => row.chat.id !== record.chat.id) ?? null);
          setDeletion(null);
          if (restored) onArchiveRestored?.(restored);
          onArchiveChanged?.();
        }
      }
    }
  };

  return (
    <Dialog open={open} onClose={close} width={600} title="Search chats" top="12vh" centerX={centerX}>
      <div className="desktop-chat-design chat-search-design">
        <WorkSearchField query={query} disabled={archiveActionBusy} listboxId={listboxId}
          selectedOptionId={results[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined}
          searchInputRef={searchInputRef} onChange={updateQuery} onMove={moveSelection} onSelect={() => select(selectedIndex)} onClose={close}
          onRestore={activeFilter === "Archived" && !archiveActionBusy ? () => {
            const result = results[selectedIndex];
            if (result?.kind === "chat") void applyArchivedAction("restore", result.record);
          } : undefined}/>
        <div role="tablist" aria-label="Search scope" className="chat-search-filters">
          {(["All", "Chats", "Projects", "Archived", "Shared"] as const).filter(scope => organizationStatus !== "none" || scope !== "Shared").map(scope => <button key={scope} type="button" role="tab" aria-selected={activeFilter === scope} disabled={archiveActionBusy || scope === "Shared" && !shared.available || scope === "Projects" && !onSelectProject}
            className="chat-search-filter"
            onClick={() => { setFilter(scope); setSelectedIndex(0); setDeletion(null); }}><Badge style={{ background: activeFilter === scope ? "var(--chat-fill)" : "transparent", color: "inherit", border: "1px solid var(--chat-line)", borderRadius: 6, padding: "0 6px", height: 24, fontSize: 13, lineHeight: "18px", fontWeight: 500, gap: 6 }}>{activeFilter === scope ? <Check size={12} aria-hidden/> : null}{scope}</Badge></button>)}
        </div>
        {archiveActionError && !deleteTarget ? <p role="alert" className="mt-2 px-1 text-xs" style={{ color: "var(--danger)" }}>{archiveActionError}</p> : null}
        <SearchArchiveDeleteDialog target={deleteTarget} busy={archiveActionBusy} error={archiveActionError}
          onCancel={() => setDeletion(null)} onConfirm={() => { if (deleteTarget) void applyArchivedAction("delete", deleteTarget); }}/>
        <div className="chat-search-results max-h-[min(480px,60vh)] overflow-y-auto" style={{ borderColor: "var(--border-subtle)" }}>
          {activeFilter === "Archived" && !query.trim() ? <p className="px-2 pb-1 text-xs" style={{ color: "var(--chat-muted)" }}>Recently archived</p> : null}
          {activeFilter === "Archived" && !searchLoading && !searchError && results.length === 0 ? <p className="px-2 py-4 text-sm" style={{ color: "var(--chat-muted)" }}>{query.trim() ? "No archived chats match your search." : "No archived chats."}</p> : null}
          {searchLoading ? <p role="status" className="px-3 py-2 text-xs">Searching all chats…</p> : null}
          {searchError ? <p role="alert" className="px-3 py-2 text-xs">{searchError}</p> : null}
          {activeFilter !== "Shared" && status === "loading" && records.length === 0 ? (
            <p role="status" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
          ) : null}
          {activeFilter !== "Shared" && status === "error" && records.length === 0 ? (
            <p role="alert" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-secondary)" }}>Chats could not be loaded.</p>
          ) : null}
          {activeFilter !== "Shared" && status === "error" && records.length > 0 ? (
            <p role="status" className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
              Showing recently loaded chats. Refresh failed.
            </p>
          ) : null}
          {activeFilter === "All" && status !== "loading" && status !== "error" && records.length === 0 && results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
          ) : null}
          {records.length > 0 && results.length === 0 && activeFilter !== "Shared" ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats found.</p>
          ) : null}
          {activeFilter === "Shared" && shared.loading ? <p role="status" className="px-3 py-8 text-center text-sm">Loading shared items…</p> : null}
          {activeFilter === "Shared" && shared.error ? <p role="alert" className="px-3 py-8 text-center text-sm">{shared.error}</p> : null}
          {activeFilter === "Shared" && !shared.loading && !shared.error && results.length === 0 ? <p className="px-3 py-8 text-center text-sm">No shared items found.</p> : null}
          {activeFilter === "Projects" && results.length === 0 ? <p className="px-3 py-8 text-center text-sm">No projects found.</p> : null}
          {results.length > 0 ? (
            <div id={listboxId} role="listbox" aria-label={query ? "Chat search results" : "Recent chats"}>
              {results.map((result, index) => (
                <div key={result.key} className="chat-search-result-row flex items-center">
                <button
                  id={`${listboxId}-option-${index}`}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-label={`${result.label}, ${result.contextLabel}`}
                  aria-selected={index === selectedIndex}
                  className="flex w-full min-w-0 items-center gap-3 border-b px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                  style={{ borderColor: "var(--border-subtle)" }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => select(index)}
                >
                  {result.kind === "project" ? <Folder size={15} aria-hidden className="shrink-0" /> : result.kind === "shared" ? <UsersIcon size={15} aria-hidden className="shrink-0" /> : <MessageSquare size={15} aria-hidden className="shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" style={{ color: "var(--text-primary)" }}>{result.label}</span>
                    <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{activeFilter === "Archived" && result.kind === "chat" ? `${result.project?.name ? result.project.name + " · " : ""}Archived ${archivedDateLabel(result.record)}` : result.contextLabel}</span>
                  </span>
                </button>
                {activeFilter === "Archived" && result.kind === "chat" ? <div className="chat-search-row-actions">
                  <button type="button" aria-label={`Restore ${result.label}`} title="Restore ⌘R" disabled={archiveActionBusy} onClick={() => { void applyArchivedAction("restore", result.record); }}><ArchiveRestore size={14} aria-hidden/></button>
                  <button type="button" aria-label={`Delete ${result.label}`} title="Delete" disabled={archiveActionBusy} style={{color:"var(--chat-danger)"}} onClick={() => { setDeletion({ scope: actionScope, record: result.record }); }}><Trash2 size={14} aria-hidden/></button>
                </div> : null}
                </div>
              ))}
            </div>
          ) : null}
          {serverCursor ? <button type="button" className="w-full px-3 py-2 text-center text-xs hover:bg-[var(--bg-hover)]" disabled={searchLoading} onClick={() => { void loadMore(); }}>Show more results</button> : null}
        </div>
        {activeFilter === "Archived" ? <button type="button" className="chat-search-open-archive" disabled={archiveActionBusy} onClick={() => { onOpenArchivedList?.(); close(); }}><Archive size={15} aria-hidden/><span>Open the archived list</span><ChevronRight size={14} aria-hidden/></button> : null}
        <footer className="chat-search-footer">↑↓ Move <span>↵ Open</span>{activeFilter === "Archived" ? <span>⌘R Restore</span> : null}<span>esc Close</span></footer>
      </div>
    </Dialog>
  );
}
