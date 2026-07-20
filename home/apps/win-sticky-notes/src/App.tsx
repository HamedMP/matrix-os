import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, StickyNote as StickyNoteIcon, Trash2 } from "lucide-react";
import {
  MAX_NOTE_TEXT,
  MAX_NOTES,
  NOTES_KEY,
  NOTE_COLORS,
  colorFor,
  createNote,
  formatNoteTime,
  noteSnippet,
  parseStickyNotes,
  sortNotesByRecency,
  type NoteColorId,
  type StickyNote,
} from "./sticky-notes-model";

const TIME_REFRESH_MS = 60_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const notesRef = useRef(notes);
  const failedSaveRef = useRef<StickyNote[] | null>(null);
  const saveAttemptRef = useRef(0);

  // Initial load. With no bridge the app degrades to in-memory notes only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: StickyNote[] = [];
      try {
        const read = window.MatrixOS?.readData;
        stored = read ? parseStickyNotes(await read(NOTES_KEY)) : [];
        if (!cancelled && read) setPersistenceReady(true);
      } catch (err: unknown) {
        console.warn("[sticky-notes] load failed:", errMsg(err));
        if (!cancelled) setLoadError("Notes could not be loaded.");
        return;
      }
      if (cancelled) return;
      const sorted = sortNotesByRecency(stored);
      notesRef.current = stored;
      setNotes(stored);
      setSelectedId(sorted[0]?.id ?? null);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const retryLoad = useCallback(() => {
    setLoaded(false);
    setPersistenceReady(false);
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const persistNotes = useCallback((value: StickyNote[]) => {
    if (!persistenceReady) return;
    const attempt = ++saveAttemptRef.current;
    // Start persistence in the user event. AppViewer owns the ordered request
    // queue, so the write can finish after closing destroys this iframe.
    void (async () => {
      try {
        if (!window.MatrixOS?.writeData) throw new Error("data bridge unavailable");
        await window.MatrixOS.writeData(NOTES_KEY, value);
        if (attempt === saveAttemptRef.current) {
          failedSaveRef.current = null;
          setSaveError(null);
        }
      } catch (err: unknown) {
        console.warn("[sticky-notes] save failed:", errMsg(err));
        if (attempt === saveAttemptRef.current) {
          failedSaveRef.current = value;
          setSaveError("Changes could not be saved.");
        }
      }
    })();
  }, [persistenceReady]);

  const retrySave = useCallback(() => {
    persistNotes(failedSaveRef.current ?? notesRef.current);
  }, [persistNotes]);

  const updateNotes = useCallback((updater: (current: StickyNote[]) => StickyNote[]) => {
    const next = updater(notesRef.current);
    notesRef.current = next;
    setNotes(next);
    persistNotes(next);
  }, [persistNotes]);

  // Refresh relative timestamps in the list once a minute.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), TIME_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const sorted = useMemo(() => sortNotesByRecency(notes), [notes]);
  const selected = sorted.find((note) => note.id === selectedId) ?? null;

  const addNote = useCallback(() => {
    if (!loaded) return;
    // Match the persistence cap: creating beyond MAX_NOTES would silently
    // drop the oldest notes on the next load.
    if (notesRef.current.length >= MAX_NOTES) return;
    const note = createNote(newId(), Date.now());
    updateNotes((cur) => (cur.length >= MAX_NOTES ? cur : [note, ...cur]));
    setSelectedId(note.id);
    // Focus after the editor re-renders with the new selection. rAF is not
    // available in every host (e.g. jsdom), so guard it.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  }, [loaded, updateNotes]);

  const updateSelectedText = useCallback(
    (text: string) => {
      if (!selectedId) return;
      const now = Date.now();
      updateNotes((cur) =>
        cur.map((note) =>
          note.id === selectedId ? { ...note, text: text.slice(0, MAX_NOTE_TEXT), updatedAt: now } : note,
        ),
      );
    },
    [selectedId, updateNotes],
  );

  const setSelectedColor = useCallback(
    (color: NoteColorId) => {
      if (!selectedId) return;
      const now = Date.now();
      updateNotes((cur) =>
        cur.map((note) => (note.id === selectedId ? { ...note, color, updatedAt: now } : note)),
      );
    },
    [selectedId, updateNotes],
  );

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    const remaining = sorted.filter((note) => note.id !== selected.id);
    updateNotes(() => remaining);
    setSelectedId(remaining[0]?.id ?? null);
  }, [selected, sorted, updateNotes]);

  return (
    <main className="sn-app">
      <header className="sn-header">
        <div className="sn-brand">
          <span className="sn-brand-mark" aria-hidden="true">
            <StickyNoteIcon size={17} />
          </span>
          <div className="sn-brand-text">
            <strong>Sticky Notes</strong>
            <span>{loaded ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}` : "Loading…"}</span>
          </div>
        </div>
        <button className="sn-new" type="button" onClick={addNote} disabled={!loaded || loadError !== null}>
          <Plus size={16} /> New note
        </button>
      </header>

      {saveError ? (
        <div className="sn-save-error" role="alert">
          <span>{saveError} Your edits are still here.</span>
          <button type="button" onClick={retrySave}>
            Retry save
          </button>
        </div>
      ) : null}

      <div className="sn-body">
        <aside className="sn-list" aria-label="Notes list">
          {sorted.length === 0 ? (
            <div className="sn-list-empty">
              <span>No notes yet</span>
            </div>
          ) : (
            <ul>
              {sorted.map((note) => {
                const color = colorFor(note.color);
                return (
                  <li key={note.id}>
                    <button
                      type="button"
                      className={note.id === selectedId ? "sn-item sn-item--active" : "sn-item"}
                      aria-current={note.id === selectedId ? "true" : undefined}
                      onClick={() => setSelectedId(note.id)}
                    >
                      <span
                        className="sn-item-chip"
                        style={{ background: color.paper, borderColor: color.chrome }}
                        aria-hidden="true"
                      />
                      <span className="sn-item-text">
                        <strong>{noteSnippet(note.text)}</strong>
                        <span>{formatNoteTime(note.updatedAt, nowTick)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="sn-editor" aria-label="Note editor">
          {loadError ? (
            <div className="sn-empty" role="alert">
              <span className="sn-empty-mark" aria-hidden="true">
                <StickyNoteIcon size={30} />
              </span>
              <strong>{loadError}</strong>
              <span>Your saved notes were not changed. Check the connection and try again.</span>
              <button className="sn-new" type="button" onClick={retryLoad}>
                Retry
              </button>
            </div>
          ) : !selected ? (
            <div className="sn-empty">
              <span className="sn-empty-mark" aria-hidden="true">
                <StickyNoteIcon size={30} />
              </span>
              <strong>No note selected</strong>
              <span>Jot something down — notes save automatically as you type.</span>
              <button className="sn-new" type="button" onClick={addNote} disabled={!loaded}>
                <Plus size={16} /> New note
              </button>
            </div>
          ) : (
            <article className="sn-paper" style={{ background: colorFor(selected.color).paper }}>
              <div className="sn-paper-bar" style={{ background: colorFor(selected.color).chrome }}>
                <div className="sn-colors" role="radiogroup" aria-label="Note color">
                  {NOTE_COLORS.map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      role="radio"
                      aria-checked={selected.color === color.id}
                      aria-label={color.label}
                      title={color.label}
                      className={selected.color === color.id ? "sn-color sn-color--on" : "sn-color"}
                      style={{ background: color.paper, borderColor: color.chrome }}
                      onClick={() => setSelectedColor(color.id)}
                    >
                      {selected.color === color.id ? <Check size={11} /> : null}
                    </button>
                  ))}
                </div>
                <button
                  className="sn-delete"
                  type="button"
                  aria-label="Delete note"
                  title="Delete note"
                  onClick={deleteSelected}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <textarea
                ref={editorRef}
                className="sn-text"
                aria-label="Note text"
                placeholder="Take a note…"
                value={selected.text}
                maxLength={MAX_NOTE_TEXT}
                onChange={(e) => updateSelectedText(e.target.value)}
              />
            </article>
          )}
        </section>
      </div>
    </main>
  );
}
