import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenText,
  Check,
  Clock3,
  FilePlus2,
  Hash,
  Pin,
  PinOff,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import RichEditor from "./RichEditor";
import {
  collectTags,
  createNote,
  filterNotes,
  hydrateNote,
  serializeTags,
  type Note,
  type TiptapDoc,
} from "./notes-model";

const APP_ID = "notes";
const KV_KEY = "notes";
const LOCAL_KEY = `matrixos.${APP_ID}.${KV_KEY}`;
const SAVE_DELAY_MS = 500;
const MAX_CREATE_TRACKERS = 100;

type SaveState = "idle" | "saving" | "saved" | "error";

function evictOldestMapEntry<K, V>(map: Map<K, V>): void {
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

// Apps run inside a sandboxed, null-origin srcdoc iframe with CSP
// `connect-src 'self'`, so a direct fetch() to the gateway is always blocked.
// The only valid persistence transport is window.MatrixOS.db (postMessage).
// This local fallback is for the no-bridge case (e.g. jsdom tests); in the
// real shell window.MatrixOS.db is always injected and is used instead.
async function readKvNotes(): Promise<Note[]> {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as unknown;
    return Array.isArray(rows) ? rows.map((row) => hydrateNote(row as Record<string, unknown>)) : [];
  } catch (err: unknown) {
    console.warn("[notes] local fallback read failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function writeKvNotes(notes: Note[]): Promise<void> {
  try {
    globalThis.localStorage?.setItem(LOCAL_KEY, JSON.stringify(notes));
  } catch (err: unknown) {
    console.warn("[notes] local fallback write failed:", err instanceof Error ? err.message : String(err));
  }
}

async function loadNotes(): Promise<Note[]> {
  if (window.MatrixOS?.db) {
    const rows = await window.MatrixOS.db.find("notes", { orderBy: { updated_at: "desc" } });
    return rows.map((row) => hydrateNote(row as Record<string, unknown>));
  }
  return readKvNotes();
}

function noteRowData(note: Note) {
  return {
    title: note.title,
    content: note.content,
    content_json: note.content_json,
    pinned: note.pinned,
    tags: serializeTags(note.tags),
  };
}

async function persistNote(note: Note, isNew: boolean): Promise<Note> {
  const db = window.MatrixOS?.db;
  if (!db) return note;
  const data = noteRowData(note);
  if (isNew) {
    const result = await db.insert("notes", data);
    return { ...note, id: result.id };
  }
  if (note.id.startsWith("note-")) {
    throw new Error("Cannot update a note before it has a database id.");
  }
  await db.update("notes", note.id, data);
  return note;
}

async function deletePersistedNote(note: Note): Promise<void> {
  const db = window.MatrixOS?.db;
  if (db && !note.id.startsWith("note-")) {
    await db.delete("notes", note.id);
  }
}

function relativeTime(iso: string, nowMs = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const diffMs = nowMs - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <BookOpenText size={34} />
      </div>
      <h2>No notes yet</h2>
      <p>Capture a thought, draft a plan, or save a reference. Press Cmd/Ctrl+N to begin.</p>
      <button className="button button--primary" type="button" onClick={onCreate}>
        <FilePlus2 size={16} />
        New note
      </button>
    </div>
  );
}

function NoteCard({
  note,
  active,
  nowMs,
  onSelect,
}: {
  note: Note;
  active: boolean;
  nowMs: number;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={active ? "note-card note-card--active" : "note-card"}
      type="button"
      onClick={() => onSelect(note.id)}
    >
      <span className="note-card__title">
        {note.pinned ? <Pin size={13} /> : null}
        {note.title}
      </span>
      <span className="note-card__preview">{note.preview}</span>
      <span className="note-card__meta">{relativeTime(note.updated_at ?? "", nowMs)}</span>
    </button>
  );
}

function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("all");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const notesRef = useRef<Note[]>([]);
  const pendingCreatesRef = useRef<Map<string, Promise<Note>>>(new Map());
  const resolvedCreatesRef = useRef<Map<string, string>>(new Map());
  const deletedCreatesRef = useRef<Map<string, true>>(new Map());

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const reload = useCallback(() => {
    setError(null);
    loadNotes()
      .then((nextNotes) => {
        setNotes(nextNotes);
        setActiveId((current) => current ?? nextNotes[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        console.warn("[notes] load failed:", err instanceof Error ? err.message : String(err));
        setError("Notes could not be loaded.");
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    reload();
    return window.MatrixOS?.db?.onChange?.("notes", reload);
  }, [reload]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleNotes = useMemo(() => filterNotes(notes, query, activeTag), [notes, query, activeTag]);
  const pinnedNotes = useMemo(() => visibleNotes.filter((note) => note.pinned), [visibleNotes]);
  const otherNotes = useMemo(() => visibleNotes.filter((note) => !note.pinned), [visibleNotes]);
  const tags = useMemo(() => collectTags(notes), [notes]);
  const activeNote = notes.find((note) => note.id === activeId) ?? null;
  const wordCount = activeNote?.content.trim() ? activeNote.content.trim().split(/\s+/).length : 0;

  const persistAllIfFallback = useCallback((nextNotes: Note[]) => {
    if (window.MatrixOS?.db) return;
    writeKvNotes(nextNotes).catch((err: unknown) => {
      console.warn("[notes] fallback save failed:", err instanceof Error ? err.message : String(err));
      setError("Notes could not be saved.");
      setSaveState("error");
    });
  }, []);

  const createNewNote = useCallback(() => {
    const draft = createNote({
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: "Untitled",
      content: "",
      content_json: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Untitled" }] },
          { type: "paragraph" },
        ],
      },
      pinned: false,
    });
    const nextNotes = [draft, ...notes];
    setNotes(nextNotes);
    setActiveId(draft.id);
    setSaveState("saving");
    const createPromise = persistNote(draft, true);
    if (pendingCreatesRef.current.size >= MAX_CREATE_TRACKERS) {
      evictOldestMapEntry(pendingCreatesRef.current);
    }
    pendingCreatesRef.current.set(draft.id, createPromise);
    createPromise
      .then((saved) => {
        if (deletedCreatesRef.current.delete(draft.id)) {
          resolvedCreatesRef.current.delete(draft.id);
          deletePersistedNote(saved).catch((err: unknown) => {
            console.warn("[notes] pending create cleanup failed:", err instanceof Error ? err.message : String(err));
            setError("Note could not be deleted.");
          });
          setSaveState("saved");
          return;
        }
        if (resolvedCreatesRef.current.size >= MAX_CREATE_TRACKERS) {
          evictOldestMapEntry(resolvedCreatesRef.current);
        }
        if (saved.id !== draft.id) {
          resolvedCreatesRef.current.set(draft.id, saved.id);
        }
        setNotes((currentNotes) => {
          const savedNotes = currentNotes.map((note) =>
            note.id === draft.id ? { ...note, id: saved.id, created_at: saved.created_at } : note,
          );
          persistAllIfFallback(savedNotes);
          return savedNotes;
        });
        setActiveId((current) => (current === draft.id ? saved.id : current));
        setSaveState("saved");
      })
      .catch((err: unknown) => {
        console.warn("[notes] create failed:", err instanceof Error ? err.message : String(err));
        setError("Note could not be created.");
        setSaveState("error");
      })
      .finally(() => {
        pendingCreatesRef.current.delete(draft.id);
      });
  }, [notes, persistAllIfFallback]);

  const persistWhenReady = useCallback(async (note: Note): Promise<Note> => {
    if (!note.id.startsWith("note-")) return persistNote(note, false);
    const pendingCreate = pendingCreatesRef.current.get(note.id);
    if (!pendingCreate) {
      const resolvedId = resolvedCreatesRef.current.get(note.id);
      if (!resolvedId) {
        const retryPromise = persistNote(note, true).finally(() => {
          pendingCreatesRef.current.delete(note.id);
        });
        if (pendingCreatesRef.current.size >= MAX_CREATE_TRACKERS) {
          evictOldestMapEntry(pendingCreatesRef.current);
        }
        pendingCreatesRef.current.set(note.id, retryPromise);
        const saved = await retryPromise;
        if (resolvedCreatesRef.current.size >= MAX_CREATE_TRACKERS) {
          evictOldestMapEntry(resolvedCreatesRef.current);
        }
        if (saved.id !== note.id) {
          resolvedCreatesRef.current.set(note.id, saved.id);
        }
        const latest = notesRef.current.find((candidate) => candidate.id === note.id) ?? note;
        const savedLatest = { ...latest, id: saved.id, created_at: saved.created_at };
        setNotes((currentNotes) => {
          const savedNotes = currentNotes.map((candidate) => (candidate.id === note.id ? savedLatest : candidate));
          persistAllIfFallback(savedNotes);
          return savedNotes;
        });
        setActiveId((current) => (current === note.id ? saved.id : current));
        return savedLatest;
      }
      resolvedCreatesRef.current.delete(note.id);
      const latest = notesRef.current.find((candidate) => candidate.id === resolvedId) ?? {
        ...note,
        id: resolvedId,
      };
      return persistNote(latest, false);
    }
    const saved = await pendingCreate;
    const latest = notesRef.current.find((candidate) => candidate.id === saved.id)
      ?? notesRef.current.find((candidate) => candidate.id === note.id)
      ?? note;
    return persistNote({ ...latest, id: saved.id, created_at: saved.created_at }, false);
  }, [persistAllIfFallback]);

  const updateActiveNote = useCallback(
    (patch: Partial<Pick<Note, "title" | "content" | "content_json" | "pinned" | "tags">>) => {
      if (!activeNote) return;
      const shouldRecomputeTags =
        !("tags" in patch) && ("content" in patch || "content_json" in patch);
      const nextNote = createNote({
        ...activeNote,
        ...patch,
        tags: shouldRecomputeTags ? null : (patch.tags ?? activeNote.tags),
        updated_at: new Date().toISOString(),
      });
      const nextNotes = notes.map((note) => (note.id === activeNote.id ? nextNote : note));
      setNotes(nextNotes);
      setSaveState("saving");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        persistWhenReady(nextNote)
          .then((saved) => {
            setNotes((currentNotes) => {
              const savedNotes = currentNotes.map((note) =>
                note.id === saved.id || note.id === nextNote.id ? saved : note,
              );
              persistAllIfFallback(savedNotes);
              return savedNotes;
            });
            setSaveState("saved");
          })
          .catch((err: unknown) => {
            console.warn("[notes] update failed:", err instanceof Error ? err.message : String(err));
            setError("Note could not be saved.");
            setSaveState("error");
          });
      }, SAVE_DELAY_MS);
    },
    [activeNote, notes, persistAllIfFallback, persistWhenReady],
  );

  const deleteActiveNote = useCallback(() => {
    if (!activeNote) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (activeNote.id.startsWith("note-")) {
      if (deletedCreatesRef.current.size >= MAX_CREATE_TRACKERS) {
        evictOldestMapEntry(deletedCreatesRef.current);
      }
      deletedCreatesRef.current.set(activeNote.id, true);
    }
    deletePersistedNote(activeNote)
      .then(() => {
        setNotes((currentNotes) => {
          const remaining = currentNotes.filter((note) => note.id !== activeNote.id);
          setActiveId(remaining[0]?.id ?? null);
          persistAllIfFallback(remaining);
          return remaining;
        });
      })
      .catch((err: unknown) => {
        console.warn("[notes] delete failed:", err instanceof Error ? err.message : String(err));
        setError("Note could not be deleted.");
      });
  }, [activeNote, persistAllIfFallback]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        createNewNote();
        return;
      }
      if (modifier && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (activeNote) updateActiveNote({});
        return;
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeNote, createNewNote, updateActiveNote]);

  if (!loaded) {
    return <div className="loading">Opening Notes</div>;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Notes</h1>
          </div>
          <button className="icon-button" type="button" onClick={createNewNote} title="New note (Cmd/Ctrl+N)">
            <FilePlus2 size={18} />
          </button>
        </div>
        <label className="search-field">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
          />
        </label>
        <div className="tag-strip" aria-label="Tags">
          <button
            className={activeTag === "all" ? "tag tag--active" : "tag"}
            type="button"
            onClick={() => setActiveTag("all")}
          >
            All
          </button>
          {tags.map((tag) => (
            <button
              className={activeTag === tag ? "tag tag--active" : "tag"}
              type="button"
              onClick={() => setActiveTag(activeTag === tag ? "all" : tag)}
              key={tag}
            >
              <Hash size={12} />
              {tag}
            </button>
          ))}
        </div>
        <div className="note-list">
          {pinnedNotes.length > 0 ? (
            <>
              <div className="note-list__section" aria-hidden>
                <Pin size={11} /> Pinned
              </div>
              {pinnedNotes.map((note) => (
                <NoteCard key={note.id} note={note} active={note.id === activeId} nowMs={nowMs} onSelect={setActiveId} />
              ))}
            </>
          ) : null}
          {otherNotes.length > 0 && pinnedNotes.length > 0 ? (
            <div className="note-list__section" aria-hidden>
              Notes
            </div>
          ) : null}
          {otherNotes.map((note) => (
            <NoteCard key={note.id} note={note} active={note.id === activeId} nowMs={nowMs} onSelect={setActiveId} />
          ))}
          {visibleNotes.length === 0 ? <div className="empty-list">No matching notes</div> : null}
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="toolbar__status" aria-live="polite">
            {saveState === "saving" ? <Save size={14} /> : <Check size={14} />}
            {saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving" : "Saved"}
            {activeNote ? (
              <span className="toolbar__meta">
                <Clock3 size={12} /> Updated {relativeTime(activeNote.updated_at ?? "", nowMs)}
              </span>
            ) : null}
          </div>
          <div className="toolbar__actions">
            <button
              className="button"
              type="button"
              disabled={!activeNote}
              onClick={() => updateActiveNote({ pinned: !activeNote?.pinned })}
            >
              {activeNote?.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              {activeNote?.pinned ? "Unpin" : "Pin"}
            </button>
            <button className="button button--danger" type="button" disabled={!activeNote} onClick={deleteActiveNote}>
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </header>
        {error ? <div className="error-banner">{error}</div> : null}
        {activeNote ? (
          <div className="editor-grid">
            <section className="editor-pane" aria-label="Note editor">
              <input
                className="title-input"
                value={activeNote.title}
                onChange={(event) => updateActiveNote({ title: event.target.value })}
                aria-label="Note title"
                placeholder="Untitled"
              />
              <RichEditor note={activeNote} onChange={(patch) => updateActiveNote(patch)} />
              <footer className="editor-footer">
                <span>{wordCount} words</span>
                <span className="editor-footer__tags">
                  {activeNote.tags.length > 0
                    ? activeNote.tags.map((tag) => (
                        <span className="footer-tag" key={tag}>
                          <Hash size={10} />
                          {tag}
                        </span>
                      ))
                    : "Add #tags inline to organize"}
                </span>
              </footer>
            </section>
          </div>
        ) : (
          <EmptyState onCreate={createNewNote} />
        )}
      </section>
    </main>
  );
}

export default App;
