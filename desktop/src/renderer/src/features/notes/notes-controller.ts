import type { JSONContent } from "@tiptap/react";
import type { ApiClient } from "../../lib/api";
import { isCurrentRuntimeGeneration } from "../../stores/runtime-generation";

export interface Note {
  id: string;
  title: string;
  content: string;
  content_json: JSONContent | null;
  created_at: string;
  updated_at: string;
}

interface NotesState {
  notes: Note[];
  selectedId: string | null;
  dirtyIds: string[];
  loading: boolean;
  creating: boolean;
  saving: boolean;
  hasMore: boolean;
  error: string | null;
}

const PAGE_SIZE = 100;
const MAX_LOADED_NOTES = 1000;
const EMPTY_DOCUMENT: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

function hydrate(row: Record<string, unknown>): Note {
  if (typeof row.id !== "string") throw new Error("Invalid note");
  const now = new Date().toISOString();
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : "",
    content: typeof row.content === "string" ? row.content : "",
    content_json: row.content_json && typeof row.content_json === "object"
      && "type" in row.content_json && row.content_json.type === "doc"
      ? row.content_json as JSONContent : null,
    created_at: typeof row.created_at === "string" ? row.created_at : now,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : now,
  };
}

/** One bounded note session; writes stay ordered even when the selection changes. */
export class NotesController {
  private state: NotesState = {
    notes: [], selectedId: null, dirtyIds: [], loading: true, creating: false,
    saving: false, hasMore: false, error: null,
  };
  private listener: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private savingPromise: Promise<boolean> | null = null;
  private offset = 0;

  constructor(private api: ApiClient, private generation: number) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listener = listener;
    return () => { this.listener = null; };
  };
  private current = () => isCurrentRuntimeGeneration(this.generation);
  private set(patch: Partial<NotesState>) {
    this.state = { ...this.state, ...patch };
    if (this.current()) this.listener?.();
  }
  private query<T>(body: Record<string, unknown>, allowDetachedSave = false): Promise<T> {
    if (!allowDetachedSave && !this.current()) return Promise.reject(new Error("Runtime changed"));
    return this.api.post<T>("/api/bridge/query", { app: "notes", table: "notes", ...body });
  }

  load = async (more = false) => {
    if (more && this.state.notes.length >= MAX_LOADED_NOTES) return;
    this.set({ loading: true, error: null });
    try {
      const rows = await this.query<Record<string, unknown>[]>({
        action: "find", orderBy: { created_at: "desc", id: "desc" },
        limit: PAGE_SIZE, offset: more ? this.offset : 0,
      });
      if (!this.current()) return;
      const loaded = rows.map(hydrate);
      const existing = more ? this.state.notes : this.state.notes.filter((note) => this.state.dirtyIds.includes(note.id));
      const notes = [...existing, ...loaded.filter((note) => !existing.some((item) => item.id === note.id))];
      this.offset = (more ? this.offset : 0) + rows.length;
      this.set({ notes, selectedId: this.state.selectedId ?? notes[0]?.id ?? null,
        hasMore: rows.length === PAGE_SIZE && notes.length < MAX_LOADED_NOTES });
    } catch (error) {
      console.warn("[notes] load failed", error);
      this.set({ error: "Notes could not be loaded. Try again." });
    } finally {
      this.set({ loading: false });
    }
  };

  select = (selectedId: string) => {
    this.set({ selectedId });
    void this.flush();
  };

  create = async () => {
    if (this.state.creating || !this.current()) return;
    if (this.state.notes.length >= MAX_LOADED_NOTES) {
      this.set({ error: "Close and reopen Notes before creating more notes." });
      return;
    }
    this.set({ creating: true, error: null });
    const now = new Date().toISOString();
    const note: Note = { id: crypto.randomUUID(), title: "", content: "", content_json: EMPTY_DOCUMENT, created_at: now, updated_at: now };
    try {
      // Client id makes a timed-out create discoverable instead of duplicating it.
      try {
        await this.query({ action: "insert", data: { ...note, pinned: false, tags: "" } });
      } catch (error) {
        const found = await this.query<Record<string, unknown> | null>({ action: "findOne", id: note.id });
        if (!found) throw error;
      }
      this.set({ notes: [note, ...this.state.notes], selectedId: note.id });
    } catch (error) {
      console.warn("[notes] create failed", error);
      this.set({ error: "The note could not be created. Try again." });
    } finally {
      this.set({ creating: false });
    }
  };

  edit = (id: string, patch: Partial<Pick<Note, "title" | "content" | "content_json">>) => {
    const previous = this.state.notes.find((note) => note.id === id);
    if (!previous || !this.current()) return;
    const note = { ...previous, ...patch, updated_at: new Date().toISOString() };
    this.set({ notes: this.state.notes.map((item) => item.id === id ? note : item),
      dirtyIds: this.state.dirtyIds.includes(id) ? this.state.dirtyIds : [...this.state.dirtyIds, id] });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 500);
  };

  flush = (): Promise<boolean> => {
    clearTimeout(this.timer);
    if (this.savingPromise) return this.savingPromise;
    this.savingPromise = this.savePending().finally(() => { this.savingPromise = null; });
    return this.savingPromise;
  };

  private async savePending(): Promise<boolean> {
    this.set({ saving: true });
    try {
      while (this.state.dirtyIds.length) {
        const id = this.state.dirtyIds[0];
        const note = this.state.notes.find((item) => item.id === id);
        if (!note) {
          this.set({ dirtyIds: this.state.dirtyIds.filter((item) => item !== id) });
          continue;
        }
        const data = { title: note.title, content: note.content, content_json: note.content_json };
        if (new TextEncoder().encode(JSON.stringify(data)).length > 900_000) {
          this.set({ error: "This note is too large to save. Split it into smaller notes." });
          return false;
        }
        // The API is pinned to the controller's original runtime. Detached
        // controllers may finish already queued writes after a runtime switch,
        // while set() suppresses their stale UI notifications.
        await this.query({ action: "update", id, data }, true);
        // Only mark the exact version sent as saved; keep typing done in flight.
        if (this.state.notes.find((item) => item.id === id) === note) {
          this.set({ dirtyIds: this.state.dirtyIds.filter((item) => item !== id) });
        }
      }
      this.set({ error: null });
      return true;
    } catch (error) {
      console.warn("[notes] save failed", error);
      this.set({ error: "Changes could not be saved. Your edits are still here. Retry saving." });
      return false;
    } finally {
      this.set({ saving: false });
    }
  }

  remove = async (id: string): Promise<boolean> => {
    if (!await this.flush()) return false;
    try {
      await this.query({ action: "delete", id });
      const notes = this.state.notes.filter((note) => note.id !== id);
      this.offset = Math.max(0, this.offset - 1);
      this.set({ notes, selectedId: this.state.selectedId === id ? notes[0]?.id ?? null : this.state.selectedId });
      return true;
    } catch (error) {
      console.warn("[notes] delete failed", error);
      this.set({ error: "The note could not be deleted. Try again." });
      return false;
    }
  };
}
