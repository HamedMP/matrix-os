import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, StickyNote as StickyNoteIcon, Trash2 } from "lucide-react";
import {
  MAX_NOTE_TEXT,
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

const SAVE_DEBOUNCE_MS = 600;
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
  const [nowTick, setNowTick] = useState(() => Date.now());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // Initial load. With no bridge the app degrades to in-memory notes only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: StickyNote[] = [];
      try {
        const read = window.MatrixOS?.readData;
        stored = read ? parseStickyNotes(await read(NOTES_KEY)) : [];
      } catch (err: unknown) {
        console.warn("[sticky-notes] load failed:", errMsg(err));
      }
      if (cancelled) return;
      const sorted = sortNotesByRecency(stored);
      setNotes(stored);
      setSelectedId(sorted[0]?.id ?? null);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced autosave; skips until the initial load settles so an empty
  // first render can never clobber stored notes.
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          await window.MatrixOS?.writeData?.(NOTES_KEY, notes);
        } catch (err: unknown) {
          console.warn("[sticky-notes] save failed:", errMsg(err));
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [notes, loaded]);

  // Refresh relative timestamps in the list once a minute.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), TIME_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const sorted = useMemo(() => sortNotesByRecency(notes), [notes]);
  const selected = sorted.find((note) => note.id === selectedId) ?? null;

  const addNote = useCallback(() => {
    const note = createNote(newId(), Date.now());
    setNotes((cur) => [note, ...cur]);
    setSelectedId(note.id);
    // Focus after the editor re-renders with the new selection. rAF is not
    // available in every host (e.g. jsdom), so guard it.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  }, []);

  const updateSelectedText = useCallback(
    (text: string) => {
      if (!selectedId) return;
      const now = Date.now();
      setNotes((cur) =>
        cur.map((note) =>
          note.id === selectedId ? { ...note, text: text.slice(0, MAX_NOTE_TEXT), updatedAt: now } : note,
        ),
      );
    },
    [selectedId],
  );

  const setSelectedColor = useCallback(
    (color: NoteColorId) => {
      if (!selectedId) return;
      const now = Date.now();
      setNotes((cur) =>
        cur.map((note) => (note.id === selectedId ? { ...note, color, updatedAt: now } : note)),
      );
    },
    [selectedId],
  );

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    const remaining = sorted.filter((note) => note.id !== selected.id);
    setNotes(remaining);
    setSelectedId(remaining[0]?.id ?? null);
  }, [selected, sorted]);

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
        <button className="sn-new" type="button" onClick={addNote}>
          <Plus size={16} /> New note
        </button>
      </header>

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
          {!selected ? (
            <div className="sn-empty">
              <span className="sn-empty-mark" aria-hidden="true">
                <StickyNoteIcon size={30} />
              </span>
              <strong>No note selected</strong>
              <span>Jot something down — notes save automatically as you type.</span>
              <button className="sn-new" type="button" onClick={addNote}>
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
