import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArchiveRestore, Check, MessageSquare, Search, Trash2, X } from "lucide-react";
import type { CanonicalChatListResponse, CanonicalChatRecord } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { Input } from "../Input.js";
import { Dialog } from "../Dialog.js";
import { Tooltip } from "../Tooltip.js";
import { archiveRestoreLocation } from "./attention-state.js";
import "./desktop-chat.css";

export interface ChatArchiveClient {
  list(input: { lifecycle: "archived"; limit: number; cursor?: string }): Promise<CanonicalChatListResponse>;
  search(query: string, input: { lifecycle: "archived"; limit: number; cursor?: string }): Promise<CanonicalChatListResponse>;
  updateLifecycle(id: string, input: { baseRevision: number; lifecycle: "active" | "archived" }): Promise<CanonicalChatRecord>;
  delete(id: string, requestId: string): Promise<unknown>;
}
type Row = CanonicalChatListResponse["items"][number];
type Project = { id?: string; slug: string; name: string };
const MAX_ROWS = 500;
const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
const archiveDate = (row: Row) => new Date(row.chat.archivedAt ?? row.chat.updatedAt);
const recent = (row: Row) => Date.now() - archiveDate(row).getTime() < 7 * 86400_000;
const indexEntries = <T,>(entries: readonly (readonly [string, T])[]) => Object.assign(Object.create(null) as Record<string, T>, Object.fromEntries(entries));
const indexedIds = (ids: readonly string[]) => indexEntries(ids.map(id => [id, true] as const));
const indexProjects = (projects: readonly Project[]) => indexEntries(projects.flatMap(project => [[project.slug, project] as const, ...(project.id ? [[project.id, project] as const] : [])]));
function dateLabel(date: Date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= today) return "Today";
  if (date.getTime() >= today - 86400_000) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ArchiveRowsState { rows: Row[]; cursor?: string; status: "loading" | "ready" | "error"; error: string | null }
interface PendingArchivePage { generation: number; removed: Record<string, true>; removedCount: number }
const emptyRows: ArchiveRowsState = { rows: [], status: "loading", error: null };
function useArchivedChatRows(client: ChatArchiveClient, query: string) {
  const [state, setState] = useState<ArchiveRowsState>(emptyRows);
  const [refresh, reload] = useReducer(value => value + 1, 0);
  const generation = useRef(0);
  const pendingPage = useRef<PendingArchivePage | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    setState(emptyRows);
    const timer = window.setTimeout(() => {
      const input = { lifecycle: "archived" as const, limit: 50 };
      void (query ? client.search(query, input) : client.list(input)).then(page => {
        if (generation.current === current) setState({ rows: page.items.slice(0, MAX_ROWS), cursor: page.nextCursor, status: "ready", error: null });
      }).catch((cause: unknown) => {
        console.warn("[chat-archive] Load failed:", cause instanceof Error ? cause.name : "UnknownError");
        if (generation.current === current) setState({ rows: [], status: "error", error: "Archived chats could not be loaded. Try again." });
      });
    }, query ? 180 : 0);
    return () => { generation.current++; pendingPage.current = null; window.clearTimeout(timer); };
  }, [client, query, refresh]);
  const removeRows = (ids: readonly string[]) => {
    const removed = indexedIds(ids);
    // A pending page may overlap the loaded rows. Keep committed removals out
    // of that response, even after they no longer participate in deduplication.
    // At most MAX_ROWS loaded IDs can be removed during one page request; the
    // request-scoped ledger is discarded on settle, query/authority change or unmount.
    const pending = pendingPage.current;
    if (pending?.generation === generation.current) {
      for (const id of ids) {
        if (!pending.removed[id] && pending.removedCount < MAX_ROWS) { pending.removed[id] = true; pending.removedCount++; }
      }
    }
    setState(previous => ({ ...previous, rows: previous.rows.filter(row => !removed[row.chat.id]) }));
  };
  const loadMore = async () => {
    if (!state.cursor || state.status === "loading" || pendingPage.current || state.rows.length >= MAX_ROWS) return;
    const current = generation.current;
    const pending: PendingArchivePage = { generation: current, removed: indexEntries([]), removedCount: 0 };
    pendingPage.current = pending;
    setState(previous => ({ ...previous, status: "loading", error: null }));
    try {
      const input = { lifecycle: "archived" as const, limit: 50, cursor: state.cursor };
      const page = await (query ? client.search(query, input) : client.list(input));
      if (generation.current !== current) return;
      setState(previous => {
        const known = indexedIds(previous.rows.map(row => row.chat.id));
        return { rows: [...previous.rows, ...page.items.filter(row => !known[row.chat.id] && !pending.removed[row.chat.id])].slice(0, MAX_ROWS), cursor: page.nextCursor, status: "ready", error: null };
      });
    } catch (cause: unknown) {
      console.warn("[chat-archive] Page failed:", cause instanceof Error ? cause.name : "UnknownError");
      if (generation.current === current) setState(previous => ({ ...previous, status: "error", error: "More archived chats could not be loaded. Try again." }));
    } finally {
      if (pendingPage.current === pending) pendingPage.current = null;
    }
  };
  return { ...state, removeRows, reload, loadMore };
}

// Lifecycle mutations deliberately run in order: stop on the first failure so a
// retry targets only failed/unattempted rows, with each revision checked by Gateway.
function sequentially<T>(items: readonly T[], apply: (item: T) => Promise<void>) {
  return items.reduce((prior, item) => prior.then(() => apply(item)), Promise.resolve());
}
function useArchivedChatActions(client: ChatArchiveClient, removeRows: (ids: readonly string[]) => void, reload: () => void, onChanged?: () => void) {
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Row[] | null>(null);
  const [undo, setUndo] = useState<CanonicalChatRecord[] | null>(null);
  const [operation, setOperation] = useState<"idle" | "applying">("idle");
  const [error, setError] = useState<string | null>(null);
  const authority = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    authority.current++; locked.current = false;
    setSelected([]); setDeleting(null); setUndo(null); setOperation("idle"); setError(null);
    return () => { authority.current++; };
  }, [client]);
  useEffect(() => {
    if (!undo?.length) return;
    const timer = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const apply = async (targets: Row[], action: "restore" | "delete") => {
    if (locked.current || !targets.length) return;
    const current = authority.current;
    locked.current = true; setOperation("applying"); setError(null);
    const completed: string[] = [];
    const restored: CanonicalChatRecord[] = [];
    try {
      await sequentially(targets, async row => {
        if (authority.current !== current) return;
        if (action === "restore") restored.push(await client.updateLifecycle(row.chat.id, { baseRevision: row.chat.revision, lifecycle: "active" }));
        else await client.delete(row.chat.id, requestId());
        completed.push(row.chat.id);
      });
    } catch (cause: unknown) {
      console.warn("[chat-archive] Action failed:", cause instanceof Error ? cause.name : "UnknownError");
      if (authority.current === current) setError("Some chats could not be updated. Try again.");
    } finally {
      if (authority.current === current) {
        const done = indexedIds(completed);
        removeRows(completed);
        setSelected(previous => previous.filter(id => !done[id]));
        setDeleting(previous => {
          const remaining = previous?.filter(row => !done[row.chat.id]);
          return remaining?.length ? remaining : null;
        });
        if (restored.length) setUndo(restored);
        if (completed.length) onChanged?.();
        locked.current = false; setOperation("idle");
      }
    }
  };
  const undoRestore = async () => {
    if (!undo?.length || locked.current) return;
    const current = authority.current;
    locked.current = true; setOperation("applying"); setError(null);
    const completed: string[] = [];
    try {
      await sequentially(undo, async row => {
        if (authority.current !== current) return;
        await client.updateLifecycle(row.chat.id, { baseRevision: row.chat.revision, lifecycle: "archived" });
        completed.push(row.chat.id);
      });
    } catch (cause: unknown) {
      console.warn("[chat-archive] Undo failed:", cause instanceof Error ? cause.name : "UnknownError");
      if (authority.current === current) setError("Some chats could not be archived again. Try again.");
    } finally {
      if (authority.current === current) {
        const done = indexedIds(completed);
        setUndo(previous => {
          const remaining = previous?.filter(row => !done[row.chat.id]);
          return remaining?.length ? remaining : null;
        });
        if (completed.length) { reload(); onChanged?.(); }
        locked.current = false; setOperation("idle");
      }
    }
  };
  const toggle = (id: string) => setSelected(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const clearForSearch = () => { setSelected([]); setDeleting(null); setError(null); };
  return { selected, setSelected, deleting, setDeleting, undo, busy: operation === "applying", error, apply, undoRestore, toggle, clearForSearch };
}

function ArchivedChatRow({ row, projectName, selected, selecting, busy, onToggle, onRestore, onDelete }: {
  row: Row; projectName?: string; selected: boolean; selecting: boolean; busy: boolean;
  onToggle(): void; onRestore(): void; onDelete(): void;
}) {
  return <div className="chat-archive-row" data-selected={selected || undefined} data-selecting={selecting || undefined}>
    <label className="chat-archive-check"><MessageSquare size={16} aria-hidden/><input type="checkbox" aria-label={`Select ${row.chat.title}`} checked={selected} disabled={busy} onChange={onToggle}/><Check className="chat-archive-tick" size={12} aria-hidden/></label>
    <span className="chat-archive-title">{row.chat.title}{projectName ? <span> · {projectName}</span> : null}</span>
    <time dateTime={archiveDate(row).toISOString()}>{dateLabel(archiveDate(row))}</time>
    <div className="chat-archive-row-actions"><Tooltip content="Restore"><Button variant="ghost" size="icon" className="desktop-chat-icon" aria-label={`Restore ${row.chat.title}`} disabled={busy} onClick={onRestore}><ArchiveRestore size={14} aria-hidden/></Button></Tooltip>
      <Tooltip content="Delete"><Button variant="ghost" size="icon" className="desktop-chat-icon chat-archive-delete" aria-label={`Delete ${row.chat.title}`} disabled={busy} onClick={onDelete}><Trash2 size={14} aria-hidden/></Button></Tooltip></div>
  </div>;
}
function ArchiveSelection({ count, busy, onRestore, onDelete, onClear }: { count: number; busy: boolean; onRestore(): void; onDelete(): void; onClear(): void }) {
  return <div role="toolbar" aria-label="Archive selection" className="chat-archive-selection"><span>{count} selected</span><div>
    <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}><ArchiveRestore size={16} aria-hidden/>Restore</Button>
    <Button variant="ghost" size="sm" className="chat-archive-delete" disabled={busy} onClick={onDelete}><Trash2 size={16} aria-hidden/>Delete</Button>
    <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}><X size={16} aria-hidden/>Clear</Button>
  </div></div>;
}

function ArchiveGroups({ groups, projectByRef, selectedIds, selecting, busy, onToggle, onRestore, onDelete }: {
  groups: readonly { label: string; rows: Row[] }[]; projectByRef: Record<string, Project>; selectedIds: Record<string, true>;
  selecting: boolean; busy: boolean; onToggle(id: string): void; onRestore(row: Row): void; onDelete(row: Row): void;
}) {
  return groups.map(group => group.rows.length ? <div key={group.label} className="chat-archive-group"><h2>{group.label}</h2><div>
    {group.rows.map(row => <ArchivedChatRow key={row.chat.id} row={row} projectName={row.projectId ? projectByRef[row.projectId]?.name : undefined} selected={Boolean(selectedIds[row.chat.id])} selecting={selecting} busy={busy}
      onToggle={() => onToggle(row.chat.id)} onRestore={() => onRestore(row)} onDelete={() => onDelete(row)}/>)}
  </div></div> : null);
}
function ArchiveDeleteConfirmation({ rows, busy, error, onClose, onConfirm }: { rows: Row[] | null; busy: boolean; error: string | null; onClose(): void; onConfirm(): void }) {
  return <Dialog open={Boolean(rows)} onClose={() => { if (!busy) onClose(); }} aria-label="Delete archived chats?" className="desktop-chat-design chat-archive-confirm">
    <h2>Delete {rows?.length === 1 ? `“${rows[0]?.chat.title}”` : `${rows?.length ?? 0} chats`} forever?</h2><p>This permanently deletes the selected chats and their messages. This cannot be undone.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>Delete forever</Button></div>
  </Dialog>;
}

function ArchiveProjectFilters({ projects, projectId, onChange }: { projects: readonly Project[]; projectId: string | null; onChange(id: string | null): void }) {
  return <div className="chat-archive-filters" aria-label="Filter by project">
    <Button variant="ghost" size="sm" aria-pressed={!projectId} onClick={() => onChange(null)}>All projects</Button>
    {projects.map(project => <Button key={project.id ?? project.slug} variant="ghost" size="sm" aria-pressed={projectId === (project.id ?? project.slug)} onClick={() => onChange(project.id ?? project.slug)}>{project.name}</Button>)}
  </div>;
}
function ArchivePageStatus({ status, hasRows, error, query, cursor, capped, busy, onMore, onSearch, onRetry }: {
  status: ArchiveRowsState["status"]; hasRows: boolean; error: string | null; query: string; cursor?: string; capped: boolean; busy: boolean;
  onMore(): void; onSearch(): void; onRetry(): void;
}) {
  return <>
    {status === "loading" ? <p role="status">Loading archived chats…</p> : !hasRows && !error ? <p>{query ? "No archived chats match your search." : "No archived chats."}</p> : null}
    {status === "error" ? <Button variant="ghost" size="sm" aria-label="Retry loading archived chats" onClick={onRetry}>Retry</Button> : null}
    {cursor ? !capped ? <Button variant="ghost" size="sm" disabled={status === "loading" || busy} onClick={onMore}>Show more</Button> : <Button variant="ghost" size="sm" onClick={onSearch}>Search to find more archived chats</Button> : null}
  </>;
}
function ArchiveUndoNotice({ rows, projectByRef, busy, onUndo }: { rows: readonly CanonicalChatRecord[] | null; projectByRef: Record<string, Project>; busy: boolean; onUndo(): void }) {
  const count = rows?.length ?? 0;
  if (!count) return null;
  const destination = archiveRestoreLocation(rows![0]!, rows![0]?.projectId ? projectByRef[rows![0]!.projectId!]?.name : undefined);
  const sameDestination = rows!.every(row => archiveRestoreLocation(row, row.projectId ? projectByRef[row.projectId]?.name : undefined) === destination);
  const label = count === 1 ? `Chat restored to ${destination}` : `${count} chats restored${sameDestination ? ` to ${destination}` : ""}`;
  return <div role="status" className="chat-lifecycle-toast"><span>{label}</span><Button variant="ghost" size="sm" disabled={busy} onClick={onUndo}>Undo</Button></div>;
}

/** One archive view for both desktop renderers. The caller keys it by verified runtime authority. */
export function ArchivedChatsPage({ client, projects, onChanged }: {
  client: ChatArchiveClient; projects: readonly Project[]; onChanged?(): void;
}) {
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const page = useArchivedChatRows(client, query.trim());
  const actions = useArchivedChatActions(client, page.removeRows, page.reload, onChanged);
  const projectByRef = useMemo(() => indexProjects(projects), [projects]);
  const availableProjectRefs = indexedIds(page.rows.flatMap(row => row.projectId ? [row.projectId] : []));
  const availableProjects = projects.filter(project => availableProjectRefs[project.id ?? ""] || availableProjectRefs[project.slug]);
  const selectedIds = indexedIds(actions.selected);
  const selectedRows = page.rows.filter(row => selectedIds[row.chat.id]);
  const visibleRows = page.rows.filter(row => !projectId || row.projectId === projectId || (row.projectId && projectByRef[row.projectId]?.id === projectId));
  const groups = [{ label: "This week", rows: visibleRows.filter(recent) }, { label: "Earlier", rows: visibleRows.filter(row => !recent(row)) }];
  const error = actions.error ?? page.error;
  return <section aria-label="Archived chats" className="desktop-chat-design chat-archive-page" onKeyDown={event => {
    if (event.key === "Escape" && !actions.deleting && !actions.busy) { event.stopPropagation(); actions.setSelected([]); }
  }}>
    <div className="chat-archive-content">
      <header className="chat-archive-header"><div><h1>Archived chats</h1><p>Restore a chat to put it back where it was.</p></div>
        <label className="chat-archive-search"><Search size={16} aria-hidden/><Input ref={searchRef} aria-label="Search archived chats" type="search" maxLength={200} placeholder="Search" value={query} disabled={actions.busy} onChange={event => { actions.clearForSearch(); setQuery(event.target.value); }}/></label>
      </header>
      {actions.selected.length ? <ArchiveSelection count={actions.selected.length} busy={actions.busy} onRestore={() => { void actions.apply(selectedRows, "restore"); }} onDelete={() => actions.setDeleting(selectedRows)} onClear={() => actions.setSelected([])}/> : null}
      {error && !actions.deleting ? <p role="alert">{error}</p> : null}
      {!actions.selected.length && (availableProjects.length > 1 || projectId) ? <ArchiveProjectFilters projects={availableProjects} projectId={projectId} onChange={setProjectId}/> : null}
      <ArchiveGroups groups={groups} projectByRef={projectByRef} selectedIds={selectedIds} selecting={actions.selected.length > 0} busy={actions.busy}
        onToggle={actions.toggle} onRestore={row => { void actions.apply([row], "restore"); }} onDelete={row => actions.setDeleting([row])}/>
      <ArchivePageStatus status={page.status} hasRows={visibleRows.length > 0} error={error} query={query.trim()} cursor={page.cursor} capped={page.rows.length >= MAX_ROWS} busy={actions.busy}
        onMore={() => { void page.loadMore(); }} onSearch={() => searchRef.current?.focus()} onRetry={() => { if (page.cursor && page.rows.length) void page.loadMore(); else page.reload(); }}/>
    </div>
    <ArchiveUndoNotice rows={actions.undo} projectByRef={projectByRef} busy={actions.busy} onUndo={() => { void actions.undoRestore(); }}/>
    <ArchiveDeleteConfirmation rows={actions.deleting} busy={actions.busy} error={actions.error} onClose={() => actions.setDeleting(null)} onConfirm={() => { if (actions.deleting) void actions.apply(actions.deleting, "delete"); }}/>
  </section>;
}
