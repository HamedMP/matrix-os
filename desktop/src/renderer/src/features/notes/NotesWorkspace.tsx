import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Notebook, Plus, Search, Trash2, X } from "@renderer/lib/hugeicons";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration } from "../../stores/runtime-generation";
import type { ApiClient } from "../../lib/api";
import { Dialog } from "../../design/primitives";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";
import NoteEditor from "./NoteEditor";
import { NotesController, registerActiveNotesController } from "./notes-controller";

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormatter.format(date);
}

export default function NotesWorkspace({ active }: { active: boolean }) {
  const api = useConnection((state) => state.api);
  const slot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const pinnedApi = useMemo(() => api?.forRuntime(slot) ?? null, [api, slot]);
  if (!pinnedApi) return <div className="m-auto text-sm text-[var(--text-tertiary)]">Connect to your Matrix computer to open Notes.</div>;
  return <NotesSession
    key={`${slot}:${authGeneration}:${captureRuntimeGeneration()}`}
    api={pinnedApi}
    active={active}
  />;
}

function NotesSession({ api, active }: { api: ApiClient; active: boolean }) {
  const [controller] = useState(() => new NotesController(api, captureRuntimeGeneration()));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const note = state.notes.find((item) => item.id === state.selectedId);
  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.notes.filter((item) => !needle || `${item.title}\n${item.content}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [state.notes, query]);

  useEffect(() => {
    const unregister = registerActiveNotesController(controller);
    void controller.load();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.getSnapshot().dirtyIds.length) {
        void controller.flush();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      unregister();
      void controller.flush();
    };
  }, [controller]);

  useEffect(() => {
    if (!active) void controller.flush();
  }, [active, controller]);

  return (
    <div className="ph-no-capture relative flex min-h-0 flex-1" data-slot="notes-workspace"
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        if (["b", "i", "n", "s"].includes(event.key.toLowerCase())) event.stopPropagation();
        if (event.key.toLowerCase() === "s") { event.preventDefault(); void controller.flush(); }
        if (event.key.toLowerCase() === "n") { event.preventDefault(); void controller.create(); }
      }}>
      <OSWindowSafeView
        area="sidebar"
        className="h-full min-h-0 w-[280px] min-w-[200px] shrink-0 border-r"
        style={{ borderColor: "var(--border-default)" }}
      >
        <aside aria-label="Notes" className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--border-default)" }}>
            <div className="flex items-center gap-1">
              <Notebook size={16} aria-hidden />
              <h1 className="text-[16px] font-medium leading-[16px] tracking-[-0.4px]">Notes</h1>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Search notes" className="flex size-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" onClick={() => setSearchOpen(!searchOpen)}><Search size={15} /></button>
              <button type="button" aria-label="New note" title="New note" disabled={state.creating || state.loading} className="flex size-6 items-center justify-center rounded-md text-white disabled:opacity-40" style={{ background: "var(--surface-overlay)" }} onClick={() => { setQuery(""); void controller.create(); }}><Plus size={16} /></button>
            </div>
          </header>
          {searchOpen && <div className="mx-3 my-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2" style={{ borderColor: "var(--border-default)" }}>
            <Search size={14} className="text-[var(--text-tertiary)]" />
            <input autoFocus type="search" aria-label="Search notes" placeholder="Search notes" value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            <button type="button" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(""); }}><X size={13} /></button>
          </div>}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ul aria-label="Note list">
              {visibleNotes.map((item) => <li key={item.id} className="group/note relative border-b" style={{ borderColor: "var(--border-default)" }}>
                <button type="button" aria-current={item.id === note?.id || undefined} className="flex w-full flex-col gap-1 px-4 py-3 pr-12 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-offset-[-2px]" style={{ background: item.id === note?.id ? "var(--bg-selected)" : undefined }} onClick={() => controller.select(item.id)}>
                  <span className="w-full truncate text-[14px] font-medium leading-5">{item.title.trim() || "Untitled"}</span>
                  <time dateTime={item.updated_at} className="text-[12px] leading-4 text-[var(--text-tertiary)]">{dateLabel(item.updated_at)}</time>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${item.title.trim() || "Untitled"}`}
                  className="absolute right-3 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] group-hover/note:opacity-100"
                  onClick={() => setDeleteTarget(item.id)}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </li>)}
            </ul>
            {state.loading ? <p role="status" className="p-4 text-xs text-[var(--text-tertiary)]">Loading notes…</p> : visibleNotes.length === 0 && <p className="p-4 text-xs text-[var(--text-tertiary)]">{query ? "No matching notes." : "Your notes will appear here."}</p>}
            {state.hasMore && <button type="button" disabled={state.loading} className="w-full p-3 text-xs text-[var(--text-secondary)]" onClick={() => void controller.load(true)}>Load more notes</button>}
          </div>
          <div className="px-4 py-3 text-[11px] text-[var(--text-tertiary)]">{state.notes.length} {state.notes.length === 1 ? "note" : "notes"}</div>
        </aside>
      </OSWindowSafeView>
      <OSWindowSafeView area="sidebar" aria-label="Note" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {note ? <>
          <div className="min-h-0 flex-1 overflow-y-auto"><NoteEditor key={note.id} note={note} controller={controller} /></div>
          {state.error && <div role="alert" className="absolute bottom-4 left-4 right-4 rounded-lg bg-[var(--bg-sunken)] p-3 text-xs text-[var(--text-secondary)] shadow-[var(--shadow-2)]">{state.error} <button type="button" className="underline" onClick={() => void controller.flush()}>Retry</button></div>}
        </> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Notebook size={36} strokeWidth={1.4} className="text-[var(--surface-purple-emphasis)]" />
          <h2 className="text-xl font-medium">A little space for your thoughts</h2>
          <p className="max-w-64 text-sm text-[var(--text-tertiary)]">Ideas, lists, and everything in between.</p>
          {state.error && <p role="alert" className="text-sm text-[var(--text-secondary)]">{state.error}</p>}
          <button type="button" disabled={state.loading || state.creating} className="mt-2 rounded-lg px-4 py-2 text-sm text-white disabled:opacity-40" style={{ background: "var(--surface-purple-emphasis)" }} onClick={() => state.error ? void controller.load() : void controller.create()}>{state.error ? "Try again" : state.creating ? "Creating…" : "Create a note"}</button>
        </div>}
        <Dialog open={deleteTarget !== null} onClose={() => { if (!deleting) setDeleteTarget(null); }} title="Delete note?" role="alertdialog" placement="center" width={360}>
          <div className="p-6 text-center">
            <h2 className="text-lg font-medium">Delete this note?</h2>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">This can’t be undone.</p>
            <div className="mt-5 flex justify-center gap-3">
              <button type="button" disabled={deleting} className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--bg-hover)]" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" disabled={deleting} className="rounded-lg bg-[var(--danger)] px-4 py-2 text-sm text-white" onClick={async () => { if (!deleteTarget) return; setDeleting(true); if (await controller.remove(deleteTarget)) setDeleteTarget(null); setDeleting(false); }}>{deleting ? "Deleting…" : "Delete"}</button>
            </div>
            {state.error && <p role="alert" className="mt-3 text-xs text-[var(--text-secondary)]">{state.error}</p>}
          </div>
        </Dialog>
      </OSWindowSafeView>
    </div>
  );
}
