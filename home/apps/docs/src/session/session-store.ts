/**
 * The observable part of a document session: the immutable state object and
 * the two listener lists (state changes, content changes).
 */

import type { DocumentChange, SessionState } from "./types";

const MAX_LISTENERS = 64;

export const EMPTY_STATE: SessionState = Object.freeze({
  status: "empty",
  source: "matrix",
  path: null,
  name: "",
  version: null,
  dirty: false,
  saveStatus: "idle",
  saveError: null,
  conflict: null,
  error: null,
  tracking: false,
  autosave: true,
  canUndo: false,
  canRedo: false,
  revisionCount: 0,
  commentCount: 0,
  lastSavedAt: null,
  documentKey: 0,
});

export class SessionStore {
  private current: SessionState;
  private readonly stateListeners = new Set<() => void>();
  private readonly changeListeners = new Set<(change: DocumentChange) => void>();
  private readonly log: (message: string, error: unknown) => void;

  constructor(initial: SessionState, log: (message: string, error: unknown) => void) {
    this.current = Object.freeze({ ...initial });
    this.log = log;
  }

  get state(): SessionState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    if (this.stateListeners.size >= MAX_LISTENERS) throw new Error("too many session listeners");
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onChange(listener: (change: DocumentChange) => void): () => void {
    if (this.changeListeners.size >= MAX_LISTENERS) throw new Error("too many session listeners");
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Publishes a new state object when a field really changes. */
  patch(partial: Partial<SessionState>): void {
    let changed = false;
    for (const key of Object.keys(partial) as Array<keyof SessionState>) {
      if (!Object.is(this.current[key], partial[key])) changed = true;
    }
    if (!changed) return;
    this.current = Object.freeze({ ...this.current, ...partial });
    for (const listener of [...this.stateListeners]) this.notify(() => listener());
  }

  emit(change: DocumentChange): void {
    for (const listener of [...this.changeListeners]) this.notify(() => listener(change));
  }

  clear(): void {
    this.stateListeners.clear();
    this.changeListeners.clear();
  }

  /** One failing listener must not stop the others or the edit that is being reported. */
  private notify(call: () => void): void {
    try {
      call();
    } catch (error) {
      this.log("docs: a session listener failed", error);
    }
  }
}
