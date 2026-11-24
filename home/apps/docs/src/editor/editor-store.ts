/**
 * The observable part of the editor: its immutable snapshot and the listener
 * lists for snapshot changes and selection changes.
 */

import { sameSelection } from "./selection";
import type { EditorSelection, EditorSnapshot } from "./types";

const MAX_LISTENERS = 64;

export class EditorStore {
  private current: EditorSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly selectionListeners = new Set<(selection: EditorSelection | null) => void>();

  constructor(
    initial: EditorSnapshot,
    private readonly log: (message: string, error: unknown) => void,
  ) {
    this.current = Object.freeze({ ...initial });
  }

  getSnapshot = (): EditorSnapshot => this.current;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error("too many editor listeners");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onSelectionChange(listener: (selection: EditorSelection | null) => void): () => void {
    if (this.selectionListeners.size >= MAX_LISTENERS) throw new Error("too many editor listeners");
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  /** Publishes a new snapshot when something in it changed. */
  publish(next: EditorSnapshot): void {
    const current = this.current;
    if (
      current.viewMode === next.viewMode &&
      current.readOnly === next.readOnly &&
      current.focused === next.focused &&
      sameSelection(current.selection, next.selection) &&
      JSON.stringify(current.activeFormat) === JSON.stringify(next.activeFormat)
    ) {
      return;
    }
    this.current = Object.freeze(next);
    for (const listener of [...this.listeners]) this.guard(() => listener(), "docs: an editor listener failed");
  }

  announceSelection(selection: EditorSelection | null): void {
    for (const listener of [...this.selectionListeners]) this.guard(() => listener(selection), "docs: a selection listener failed");
  }

  /** One failing listener must not stop the others or the edit being reported. */
  private guard(call: () => void, message: string): void {
    try {
      call();
    } catch (error) {
      this.log(message, error);
    }
  }
}
