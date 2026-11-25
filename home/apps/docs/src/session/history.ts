/**
 * Undo and redo over engine snapshots. Every document state has a number, so
 * the session can tell whether the current state is the one that was saved.
 */

import type { DocxDocument, DocxSnapshot } from "../../../_shared/office-engine/index";
import type { SessionSelection } from "./types";

/** Calls with the same merge key share a step while they are at most this far apart. */
export const MERGE_WINDOW_MS = 2_000;
export const DEFAULT_UNDO_LIMIT = 200;

interface HistoryEntry {
  before: DocxSnapshot;
  beforeState: number;
  /** Taken lazily, the first time the step is undone. */
  after: DocxSnapshot | null;
  afterState: number;
  selectionBefore: SessionSelection | null;
  selectionAfter: SessionSelection | null;
  mergeKey: string | null;
  at: number;
}

export interface HistoryStep {
  before: DocxSnapshot;
  selectionBefore: SessionSelection | null;
  selectionAfter: SessionSelection | null;
  mergeKey?: string | null;
  /** Milliseconds since the epoch. */
  at: number;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private nextState = 1;
  private currentState = 0;
  private readonly limit: number;

  constructor(limit: number = DEFAULT_UNDO_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** The number of the document state right now. */
  get current(): number {
    return this.currentState;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Records a change that was just made. Drops the redo history. */
  record(step: HistoryStep): void {
    const state = this.nextState++;
    const top = this.undoStack[this.undoStack.length - 1];
    const mergeKey = step.mergeKey ?? null;
    if (
      top !== undefined &&
      mergeKey !== null &&
      top.mergeKey === mergeKey &&
      this.redoStack.length === 0 &&
      top.afterState === this.currentState &&
      step.at - top.at <= MERGE_WINDOW_MS &&
      step.at >= top.at
    ) {
      top.after = null;
      top.afterState = state;
      top.selectionAfter = step.selectionAfter;
      top.at = step.at;
    } else {
      this.undoStack.push({
        before: step.before,
        beforeState: this.currentState,
        after: null,
        afterState: state,
        selectionBefore: step.selectionBefore,
        selectionAfter: step.selectionAfter,
        mergeKey,
        at: step.at,
      });
      if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
    }
    this.redoStack = [];
    this.currentState = state;
  }

  /** Stores where the caret ended up after the newest step, for redo. */
  noteSelection(selection: SessionSelection | null): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top !== undefined && top.afterState === this.currentState) top.selectionAfter = selection;
  }

  /** Stops the newest step from absorbing later calls. */
  sealMerge(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top !== undefined) top.mergeKey = null;
  }

  /** Restores the state before the newest step. Returns the selection to show, or false when there is nothing to undo. */
  undo(doc: DocxDocument): { selection: SessionSelection | null } | false {
    const entry = this.undoStack.pop();
    if (entry === undefined) return false;
    if (entry.after === null) entry.after = doc.snapshot();
    doc.restore(entry.before);
    entry.mergeKey = null;
    this.redoStack.push(entry);
    this.currentState = entry.beforeState;
    return { selection: entry.selectionBefore };
  }

  redo(doc: DocxDocument): { selection: SessionSelection | null } | false {
    const entry = this.redoStack.pop();
    if (entry === undefined || entry.after === null) return false;
    doc.restore(entry.after);
    this.undoStack.push(entry);
    this.currentState = entry.afterState;
    return { selection: entry.selectionAfter };
  }

  /** Forgets every step; the current state keeps its number. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
