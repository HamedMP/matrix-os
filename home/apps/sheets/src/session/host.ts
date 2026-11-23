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
 */

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
  | { status: "error"; code: SessionErrorCode; message: string };

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

  private set(next: Partial<HostState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Saves the current document's pending edits, again when more arrived
   * while the file was written. False when they could not all be saved.
   */
  private async release(discardUnsaved: boolean): Promise<boolean> {
    const current = this.state.session;
    if (current === null || discardUnsaved) return true;
    for (let attempt = 0; attempt < MAX_RELEASE_SAVES; attempt++) {
      const state = current.getState();
      if (!state.dirty) return true;
      if (state.path === null) return false;
      const outcome = await current.flush();
      if (outcome.status !== "saved" && outcome.status !== "unchanged") return false;
    }
    return !current.getState().dirty;
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
    if (!(await this.release(options.discardUnsaved === true))) {
      if (ticket === this.ticket) this.set({ opening: null });
      return { status: "unsaved" };
    }
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
    if (!(await this.release(options.discardUnsaved === true))) {
      session.dispose();
      if (ticket === this.ticket) this.set({ opening: null });
      return { status: "unsaved" };
    }
    if (ticket !== this.ticket) {
      session.dispose();
      return { status: "superseded" };
    }
    this.replace(session);
    return { status: "opened", session };
  }

  /** Starts a new, unsaved workbook as the current document. */
  async openNew(options: { discardUnsaved?: boolean; name?: string } = {}): Promise<HostOpenResult> {
    const ticket = ++this.ticket;
    if (!(await this.release(options.discardUnsaved === true))) return { status: "unsaved" };
    if (ticket !== this.ticket) return { status: "superseded" };
    const session = createSheetSession(this.deps, { name: options.name });
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
    if (!(await this.release(options.discardUnsaved === true))) {
      session.dispose();
      return { status: "unsaved" };
    }
    if (ticket !== this.ticket) {
      session.dispose();
      return { status: "superseded" };
    }
    this.replace(session);
    return { status: "opened", session };
  }

  /** Closes the current document after saving its pending edits. */
  async close(options: { discardUnsaved?: boolean } = {}): Promise<boolean> {
    const ticket = ++this.ticket;
    if (!(await this.release(options.discardUnsaved === true))) return false;
    if (ticket !== this.ticket) return false;
    this.replace(null);
    return true;
  }
}
