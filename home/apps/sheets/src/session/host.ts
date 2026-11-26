/**
 * Holds the one session an app window shows and switches between documents.
 *
 * Opening is asynchronous, so two opens can overlap. The host keeps the
 * latest: a file that finishes loading after a newer open was asked for is
 * closed again and never shown. Before it leaves a document the host saves
 * its pending edits; when that is not possible (a conflict, a failed write)
 * it stays on the document and reports `unsaved`, unless the caller chose to
 * discard them. The old document stays on screen and editable while the new
 * one loads, so its edits are saved again right before it is replaced.
 * Text still in its cell editor is committed first (see `holdEditor`); when
 * the editor refuses it, the host stays and reports `editing`.
 */

import type { Workbook } from "./engine";
import { toSessionError } from "./file-io";
import { openLocalSheetSession } from "./local";
import { createSheetSession, openSheetSession } from "./open";
import type { SheetSession } from "./session";
import type { SessionDeps, SessionErrorCode } from "./types";

export type HostOpenResult =
  | { status: "opened"; session: SheetSession }
  /** A newer open replaced this one. */
  | { status: "superseded" }
  /** The current document has edits that could not be saved. Nothing was opened. */
  | { status: "unsaved" }
  /** The current document's cell editor refused its text and still shows it. Nothing was opened. */
  | { status: "editing" }
  | { status: "error"; code: SessionErrorCode; message: string };

export type HostCloseResult = { status: "closed" } | { status: "superseded" } | { status: "unsaved" } | { status: "editing" };

/** Stores the text still in a cell editor; false when the editor refused it and keeps it open. */
export type EditorCommit = () => boolean;

type Release = "released" | "unsaved" | "editing";

export interface HostState {
  session: SheetSession | null;
  /** Path being opened, or null. */
  opening: string | null;
  error: { code: SessionErrorCode; message: string; path: string } | null;
}

const MAX_LISTENERS = 32;
/** Saves tried in a row while new edits keep arriving during the write. */
const MAX_RELEASE_SAVES = 3;

export class SessionHost {
  private state: HostState = { session: null, opening: null, error: null };
  private ticket = 0;
  private readonly listeners = new Set<() => void>();
  /** The cell editor showing the current document; one window shows one grid. */
  private editor: { session: SheetSession; commit: EditorCommit } | null = null;

  constructor(private readonly deps: SessionDeps) {}

  getState(): HostState {
    return this.state;
  }

  get session(): SheetSession | null {
    return this.state.session;
  }

  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error("too many listeners");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Lets the host commit `session`'s cell editor before it leaves the
   * document. Returns the function that stops it.
   */
  holdEditor(session: SheetSession, commit: EditorCommit): () => void {
    const entry = { session, commit };
    this.editor = entry;
    return () => {
      if (this.editor === entry) this.editor = null;
    };
  }

  private commitEditor(session: SheetSession): boolean {
    const editor = this.editor;
    return editor === null || editor.session !== session || editor.commit();
  }

  private set(next: Partial<HostState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Commits the current document's editor and saves its pending edits, again
   * when more arrived while the file was written. Runs right before the
   * document is replaced, so nothing typed meanwhile is left out.
   */
  private async release(discardUnsaved: boolean): Promise<Release> {
    const current = this.state.session;
    if (current === null || discardUnsaved) return "released";
    for (let attempt = 0; attempt < MAX_RELEASE_SAVES; attempt++) {
      if (!this.commitEditor(current)) return "editing";
      const state = current.getState();
      if (!state.dirty) return "released";
      if (state.path === null) return "unsaved";
      const outcome = await current.flush();
      if (outcome.status !== "saved" && outcome.status !== "unchanged") return "unsaved";
    }
    if (!this.commitEditor(current)) return "editing";
    return current.getState().dirty ? "unsaved" : "released";
  }

  /** Stops a move that `release` refused, clearing the opening mark when it is still this move's. */
  private stopped(ticket: number, released: Release): { status: "unsaved" | "editing" } {
    if (ticket === this.ticket) this.set({ opening: null });
    return { status: released === "editing" ? "editing" : "unsaved" };
  }

  private replace(session: SheetSession | null): void {
    const previous = this.state.session;
    this.set({ session, opening: null, error: null });
    if (previous !== null && previous !== session) previous.dispose();
  }

  /** Opens a file and makes it the current document. */
  async open(path: string, options: { discardUnsaved?: boolean } = {}): Promise<HostOpenResult> {
    const ticket = ++this.ticket;
    this.set({ opening: path, error: null });
    const before = await this.release(options.discardUnsaved === true);
    if (before !== "released") return this.stopped(ticket, before);
    if (ticket !== this.ticket) return { status: "superseded" };
    let session: SheetSession;
    try {
      session = await openSheetSession(this.deps, path);
    } catch (error: unknown) {
      if (ticket !== this.ticket) return { status: "superseded" };
      const mapped = toSessionError(error);
      this.set({ opening: null, error: { code: mapped.code, message: mapped.message, path } });
      return { status: "error", code: mapped.code, message: mapped.message };
    }
    if (ticket !== this.ticket) {
      // A newer open won while this file was loading.
      session.dispose();
      return { status: "superseded" };
    }
    // The owner may have kept editing the old document while this one loaded.
    const after = await this.release(options.discardUnsaved === true);
    if (after !== "released") {
      session.dispose();
      return this.stopped(ticket, after);
    }
    if (ticket !== this.ticket) {
      session.dispose();
      return { status: "superseded" };
    }
    this.replace(session);
    return { status: "opened", session };
  }

  /**
   * Starts a new, unsaved workbook as the current document. `template` builds
   * its starting content; it runs only once the current document was let go.
   */
  async openNew(options: { discardUnsaved?: boolean; name?: string; template?: () => Workbook | null } = {}): Promise<HostOpenResult> {
    const ticket = ++this.ticket;
    const released = await this.release(options.discardUnsaved === true);
    if (released !== "released") return { status: released };
    if (ticket !== this.ticket) return { status: "superseded" };
    const session = createSheetSession(this.deps, { name: options.name, workbook: options.template?.() ?? undefined });
    this.replace(session);
    return { status: "opened", session };
  }

  /**
   * Opens a file chosen on this computer as a local document. A file that
   * does not open is reported to the caller only: the current document
   * stays, and no error page replaces it.
   */
  async openLocal(name: string, bytes: Uint8Array, options: { discardUnsaved?: boolean } = {}): Promise<HostOpenResult> {
    const ticket = ++this.ticket;
    let session: SheetSession;
    try {
      session = await openLocalSheetSession(this.deps, name, bytes);
    } catch (error: unknown) {
      const mapped = toSessionError(error);
      return ticket === this.ticket ? { status: "error", code: mapped.code, message: mapped.message } : { status: "superseded" };
    }
    if (ticket !== this.ticket) {
      session.dispose();
      return { status: "superseded" };
    }
    const released = await this.release(options.discardUnsaved === true);
    if (released !== "released") {
      session.dispose();
      return { status: released };
    }
    if (ticket !== this.ticket) {
      session.dispose();
      return { status: "superseded" };
    }
    this.replace(session);
    return { status: "opened", session };
  }

  /** Closes the current document after saving its pending edits. */
  async close(options: { discardUnsaved?: boolean } = {}): Promise<HostCloseResult> {
    const ticket = ++this.ticket;
    const released = await this.release(options.discardUnsaved === true);
    if (released !== "released") return { status: released };
    if (ticket !== this.ticket) return { status: "superseded" };
    this.replace(null);
    return { status: "closed" };
  }
}
