import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BookOpenText,
  Bold,
  Check,
  Code,
  FilePlus2,
  Hash,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Pin,
  PinOff,
  Quote,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { htmlToMarkdown, markdownToHtml } from "./markdown";
import {
  collectTags,
  createNote,
  emptyTiptapDoc,
  filterNotes,
  hydrateNote,
  type Note,
  type TiptapDoc,
} from "./notes-model";

const APP_ID = "notes";
const KV_KEY = "notes";
const SAVE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 10_000;

type SaveState = "idle" | "saving" | "saved" | "error";

async function readKvNotes(): Promise<Note[]> {
  const params = new URLSearchParams({ app: APP_ID, key: KV_KEY });
  const response = await fetch(`/api/bridge/data?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { value?: string | null };
  if (!payload.value) return [];
  try {
    const rows = JSON.parse(payload.value) as unknown;
    return Array.isArray(rows) ? rows.map((row) => hydrateNote(row as Record<string, unknown>)) : [];
  } catch (err: unknown) {
    console.warn("[notes] ignored invalid fallback payload:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function writeKvNotes(notes: Note[]): Promise<void> {
  await fetch("/api/bridge/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      action: "write",
      app: APP_ID,
      key: KV_KEY,
      value: JSON.stringify(notes),
    }),
  });
}

async function loadNotes(): Promise<Note[]> {
  if (window.MatrixOS?.db) {
    const rows = await window.MatrixOS.db.find("notes", { orderBy: { updated_at: "desc" } });
    return rows.map((row) => hydrateNote(row as Record<string, unknown>));
  }
  return readKvNotes();
}

async function persistNote(note: Note, isNew: boolean): Promise<Note> {
  if (window.MatrixOS?.db) {
    const data = {
      title: note.title,
      content: note.content,
      content_json: note.content_json,
      pinned: note.pinned,
    };
    const legacyData = {
      title: note.title,
      content: note.content,
      pinned: note.pinned,
    };
    try {
      if (isNew || note.id.startsWith("note-")) {
        const result = await window.MatrixOS.db.insert("notes", data);
        return { ...note, id: result.id };
      }
      await window.MatrixOS.db.update("notes", note.id, data);
      return note;
    } catch (err: unknown) {
      console.warn("[notes] JSON content save fell back to legacy schema.");
      if (isNew || note.id.startsWith("note-")) {
        const result = await window.MatrixOS.db.insert("notes", legacyData);
        return { ...note, id: result.id };
      }
      await window.MatrixOS.db.update("notes", note.id, legacyData);
      return note;
    }
  }
  return note;
}

async function deletePersistedNote(note: Note): Promise<void> {
  if (window.MatrixOS?.db && !note.id.startsWith("note-")) {
    await window.MatrixOS.db.delete("notes", note.id);
  }
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <BookOpenText size={34} />
      </div>
      <h2>No notes yet</h2>
      <p>Capture a thought, draft a plan, or save a reference in markdown.</p>
      <button className="button button--primary" type="button" onClick={onCreate}>
        <FilePlus2 size={16} />
        New note
      </button>
    </div>
  );
}

function MarkdownEditor({
  note,
  onChange,
}: {
  note: Note;
  onChange: (patch: { content: string; content_json: TiptapDoc }) => void;
}) {
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const lastAppliedNoteIdRef = useRef<string | null>(null);
  const editor = useEditor({
    extensions: [StarterKit],
    content: note.content_json.content?.length ? note.content_json : markdownToHtml(note.content),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "rich-editor-content",
      },
    },
    onUpdate({ editor: activeEditor }) {
      onChange({
        content: htmlToMarkdown(activeEditor.getHTML()),
        content_json: activeEditor.getJSON() as TiptapDoc,
      });
    },
  });

  useEffect(() => {
    if (!editor || lastAppliedNoteIdRef.current === note.id) return;
    lastAppliedNoteIdRef.current = note.id;
    editor.commands.setContent(
      note.content_json.content?.length ? note.content_json : markdownToHtml(note.content),
      { emitUpdate: false },
    );
  }, [editor, note.content, note.content_json, note.id]);

  const updateMarkdownSource = useCallback((markdown: string) => {
    if (!editor) {
      onChange({ content: markdown, content_json: emptyTiptapDoc() });
      return;
    }
    editor.commands.setContent(markdownToHtml(markdown), { emitUpdate: false });
    onChange({
      content: markdown,
      content_json: editor.getJSON() as TiptapDoc,
    });
  }, [editor, onChange]);

  return (
    <div className="markdown-editor">
      <div className="format-toolbar" aria-label="Formatting toolbar">
        <button className={mode === "rich" ? "format-button format-button--active" : "format-button"} type="button" onClick={() => setMode("rich")}>Rich</button>
        <button className={mode === "source" ? "format-button format-button--active" : "format-button"} type="button" onClick={() => setMode("source")}>Markdown</button>
        <span className="format-divider" />
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1"><Heading1 size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2"><Heading2 size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleBold().run()} title="Bold"><Bold size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleItalic().run()} title="Italic"><Italic size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()} title="Bullet list"><List size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleOrderedList().run()} title="Numbered list"><ListOrdered size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleBlockquote().run()} title="Quote"><Quote size={15} /></button>
        <button className="format-button" type="button" onClick={() => editor?.chain().focus().toggleCodeBlock().run()} title="Code block"><Code size={15} /></button>
      </div>
      {mode === "source" ? (
        <textarea
          className="content-input"
          value={note.content}
          onChange={(event) => updateMarkdownSource(event.target.value)}
          spellCheck
          aria-label="Markdown content"
        />
      ) : (
        <EditorContent editor={editor} className="rich-editor" />
      )}
    </div>
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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const visibleNotes = useMemo(() => filterNotes(notes, query, activeTag), [notes, query, activeTag]);
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
      title: "Untitled",
      content: "# New note\n\nStart writing...",
      content_json: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "New note" }] },
          { type: "paragraph", content: [{ type: "text", text: "Start writing..." }] },
        ],
      },
      pinned: false,
    });
    const nextNotes = [draft, ...notes];
    setNotes(nextNotes);
    setActiveId(draft.id);
    setSaveState("saving");
    persistNote(draft, true)
      .then((saved) => {
        const savedNotes = nextNotes.map((note) => (note.id === draft.id ? saved : note));
        setNotes(savedNotes);
        setActiveId(saved.id);
        persistAllIfFallback(savedNotes);
        setSaveState("saved");
      })
      .catch((err: unknown) => {
        console.warn("[notes] create failed:", err instanceof Error ? err.message : String(err));
        setError("Note could not be created.");
        setSaveState("error");
      });
  }, [notes, persistAllIfFallback]);

  const updateActiveNote = useCallback((patch: Partial<Pick<Note, "title" | "content" | "content_json" | "pinned">>) => {
    if (!activeNote) return;
    const nextNote = createNote({
      ...activeNote,
      ...patch,
      updated_at: new Date().toISOString(),
    });
    const nextNotes = notes.map((note) => (note.id === activeNote.id ? nextNote : note));
    setNotes(nextNotes);
    setSaveState("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistNote(nextNote, false)
        .then((saved) => {
          const savedNotes = nextNotes.map((note) => (note.id === saved.id ? saved : note));
          persistAllIfFallback(savedNotes);
          setSaveState("saved");
        })
        .catch((err: unknown) => {
          console.warn("[notes] update failed:", err instanceof Error ? err.message : String(err));
          setError("Note could not be saved.");
          setSaveState("error");
        });
    }, SAVE_DELAY_MS);
  }, [activeNote, notes, persistAllIfFallback]);

  const deleteActiveNote = useCallback(() => {
    if (!activeNote) return;
    const remaining = notes.filter((note) => note.id !== activeNote.id);
    deletePersistedNote(activeNote)
      .then(() => {
        setNotes(remaining);
        setActiveId(remaining[0]?.id ?? null);
        persistAllIfFallback(remaining);
      })
      .catch((err: unknown) => {
        console.warn("[notes] delete failed:", err instanceof Error ? err.message : String(err));
        setError("Note could not be deleted.");
      });
  }, [activeNote, notes, persistAllIfFallback]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        createNewNote();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (activeNote) updateActiveNote({});
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
          <button className="icon-button" type="button" onClick={createNewNote} title="New note">
            <FilePlus2 size={18} />
          </button>
        </div>
        <label className="search-field">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes"
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
              onClick={() => setActiveTag(tag)}
              key={tag}
            >
              <Hash size={12} />
              {tag}
            </button>
          ))}
        </div>
        <div className="note-list">
          {visibleNotes.map((note) => (
            <button
              className={note.id === activeId ? "note-card note-card--active" : "note-card"}
              key={note.id}
              type="button"
              onClick={() => setActiveId(note.id)}
            >
              <span className="note-card__title">
                {note.pinned ? <Pin size={13} /> : null}
                {note.title}
              </span>
              <span className="note-card__preview">{note.preview}</span>
              <span className="note-card__meta">{new Date(note.updated_at).toLocaleDateString()}</span>
            </button>
          ))}
          {visibleNotes.length === 0 ? (
            <div className="empty-list">No matching notes</div>
          ) : null}
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="toolbar__status" aria-live="polite">
            {saveState === "saving" ? <Save size={14} /> : <Check size={14} />}
            {saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving" : "Saved"}
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
              />
              <MarkdownEditor
                note={activeNote}
                onChange={(patch) => updateActiveNote(patch)}
              />
              <footer className="editor-footer">
                <span>{wordCount} words</span>
                <span>{activeNote.tags.length} tags</span>
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
