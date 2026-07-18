import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  STICKY_COLORS,
  STICKY_MIN_HEIGHT,
  STICKY_WIDTH,
  colorFor,
  parseStickyNotes,
  welcomeNote,
  type StickyNote,
} from "./stickies-model";

const NOTES_KEY = "macos-stickies/notes";
const SAVE_DEBOUNCE_MS = 600;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const notesRef = useRef(notes);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  const zCounter = useRef(1);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Remove window-level drag listeners if the app unmounts mid-gesture.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const read = window.MatrixOS?.readData;
        const stored = read ? parseStickyNotes(await read(NOTES_KEY)) : [];
        if (cancelled) return;
        const initial = stored.length > 0 ? stored : [welcomeNote()];
        zCounter.current = initial.reduce((max, n) => Math.max(max, n.z), 1);
        setNotes(initial);
      } catch (err: unknown) {
        console.warn("[stickies] notes load failed:", errMsg(err));
        if (!cancelled) setNotes([welcomeNote()]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
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
          console.warn("[stickies] notes save failed:", errMsg(err));
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [notes, loaded]);

  const addNote = useCallback(() => {
    zCounter.current += 1;
    const z = zCounter.current;
    setNotes((current) => {
      const color = STICKY_COLORS[current.length % STICKY_COLORS.length].id;
      const offset = 40 + (current.length % 6) * 28;
      return [
        ...current,
        { id: newId(), x: offset, y: offset + 24, z, text: "", color },
      ];
    });
  }, []);

  const closeNote = useCallback((id: string) => {
    setNotes((current) => current.filter((note) => note.id !== id));
  }, []);

  const editNote = useCallback((id: string, text: string) => {
    setNotes((current) => current.map((note) => (note.id === id ? { ...note, text } : note)));
  }, []);

  const bringToFront = useCallback((id: string) => {
    zCounter.current += 1;
    const z = zCounter.current;
    setNotes((current) => current.map((note) => (note.id === id ? { ...note, z } : note)));
  }, []);

  const handleHeaderPointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0) return;
      const note = notesRef.current.find((n) => n.id === id);
      const canvas = canvasRef.current;
      if (!note || !canvas) return;
      e.preventDefault();
      bringToFront(id);
      const grabDx = e.clientX - note.x;
      const grabDy = e.clientY - note.y;

      const onMove = (ev: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        const maxX = Math.max(0, rect.width - STICKY_WIDTH);
        const maxY = Math.max(0, rect.height - 48);
        const x = Math.max(0, Math.min(maxX, ev.clientX - grabDx));
        const y = Math.max(0, Math.min(maxY, ev.clientY - grabDy));
        setNotes((current) => current.map((n) => (n.id === id ? { ...n, x, y } : n)));
      };
      const endDrag = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (dragCleanupRef.current === endDrag) dragCleanupRef.current = null;
      };
      const onUp = () => endDrag();
      // End any stale drag before starting a new one, and keep a ref so an
      // unmount mid-gesture can remove the window-level listeners.
      dragCleanupRef.current?.();
      dragCleanupRef.current = endDrag;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [bringToFront],
  );

  return (
    <div className="stickies-app" ref={canvasRef}>
      <div className="stickies-toolbar">
        <button type="button" className="stickies-add" onClick={addNote} aria-label="New note">
          <Plus size={16} />
          <span>New note</span>
        </button>
      </div>

      {notes.length === 0 && loaded ? (
        <div className="stickies-empty">
          <p>No stickies yet — press <strong>+ New note</strong> to drop one on the glass.</p>
        </div>
      ) : null}

      {notes.map((note) => {
        const color = colorFor(note.color);
        return (
          <article
            key={note.id}
            className="sticky"
            style={{
              left: note.x,
              top: note.y,
              zIndex: note.z,
              width: STICKY_WIDTH,
              minHeight: STICKY_MIN_HEIGHT,
              background: color.background,
            }}
          >
            <header
              className="sticky-header"
              style={{ background: color.header }}
              onPointerDown={(e) => handleHeaderPointerDown(e, note.id)}
            >
              <button
                type="button"
                className="sticky-close"
                aria-label="Close note"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => closeNote(note.id)}
              >
                <X size={10} strokeWidth={3} />
              </button>
            </header>
            <textarea
              className="sticky-body"
              value={note.text}
              placeholder="Type here…"
              aria-label="Sticky note"
              onChange={(e) => editNote(note.id, e.target.value)}
              onPointerDown={() => bringToFront(note.id)}
            />
          </article>
        );
      })}
    </div>
  );
}
