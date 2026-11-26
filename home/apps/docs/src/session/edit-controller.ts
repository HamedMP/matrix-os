/**
 * Editing for the document session: engine operations, batches, custom
 * mutations, and undo and redo. Every change goes through here so it gets an
 * undo step and a `DocumentChange`.
 */

import type { ApplyResult, DocxDocument, DocxOp, TextPosition } from "../../../_shared/office-engine/index";
import { emptyChange, mergeChange } from "./changes";
import type { History } from "./history";
import type { DocumentChange, MutationEffect, SessionApplyOptions, SessionMutateOptions, SessionSelection } from "./types";

const COMMENT_OPS: ReadonlySet<string> = new Set(["addComment", "replyComment", "resolveComment"]);

/** What the controller needs from the session. */
export interface EditHost {
  requireDocument(): DocxDocument;
  getDocument(): DocxDocument | null;
  isTracking(): boolean;
  author: string;
  now(): Date;
  log(message: string, error: unknown): void;
  /** Writes the Track changes toggle back into the document after a snapshot was restored. */
  syncTracking(): void;
  /** Publishes the state after a content change and tells listeners. */
  commit(change: DocumentChange): void;
}

interface Batch {
  before: ReturnType<DocxDocument["snapshot"]>;
  selectionBefore: SessionSelection | null;
  selection: SessionSelection | null;
  change: DocumentChange;
  touched: boolean;
}

function pairOf(anchor: TextPosition | null | undefined, focus: TextPosition | null | undefined): SessionSelection | null {
  if (anchor === null || anchor === undefined || focus === null || focus === undefined) return null;
  return { anchor, focus };
}

export class EditController {
  private batchState: Batch | null = null;
  private selectionSource: (() => SessionSelection | null) | null = null;

  constructor(
    private readonly host: EditHost,
    private readonly history: History,
  ) {}

  setSelectionSource(source: (() => SessionSelection | null) | null): void {
    this.selectionSource = source;
  }

  noteSelection(selection: SessionSelection | null): void {
    if (this.batchState !== null) this.batchState.selection = selection;
    else this.history.noteSelection(selection);
  }

  /** Drops a batch in progress and the history: another document is taking over. */
  reset(): void {
    this.batchState = null;
    this.history.clear();
  }

  apply(ops: readonly DocxOp[], options: SessionApplyOptions): ApplyResult {
    const doc = this.host.requireDocument();
    const batch = this.batchState;
    const own = options.positions ?? [];
    const selection = batch !== null ? batch.selection : this.readSelection();
    const positions = selection === null ? own : [...own, selection.anchor, selection.focus];
    const before = batch === null ? doc.snapshot() : null;
    const result = doc.applyOps(ops, {
      track: options.track ?? this.host.isTracking(),
      author: options.author ?? this.host.author,
      date: this.stamp(),
      positions,
    });
    const carried = selection === null ? null : pairOf(result.positions[own.length], result.positions[own.length + 1]);
    const change: DocumentChange = {
      kind: "edit",
      full: false,
      changedBlockIds: result.changedBlockIds,
      createdBlockIds: result.createdBlockIds,
      removedBlockIds: result.removedBlockIds,
      changedStoryIds: result.changedStoryIds,
      revisionIds: result.revisionIds,
      origin: options.origin ?? null,
      selection: carried,
      selectionLost: selection !== null && carried === null,
    };
    const publicResult: ApplyResult = { ...result, positions: result.positions.slice(0, own.length) };
    const touched =
      change.changedBlockIds.length + change.createdBlockIds.length + change.removedBlockIds.length > 0 ||
      ops.some((op) => COMMENT_OPS.has(op.type));
    // Nothing changed (for example deleting text that is already a pending deletion): no undo step.
    if (!touched) return publicResult;
    if (batch !== null) {
      batch.change = mergeChange(batch.change, change);
      batch.selection = carried;
      batch.touched = true;
      return publicResult;
    }
    this.history.record({
      before: before as NonNullable<typeof before>,
      selectionBefore: selection,
      selectionAfter: carried,
      mergeKey: options.mergeKey ?? null,
      at: this.host.now().getTime(),
    });
    this.host.commit(change);
    return publicResult;
  }

  batch<T>(fn: () => T, origin: string | null): T {
    if (this.batchState !== null) return fn();
    const doc = this.host.requireDocument();
    const selection = this.readSelection();
    const batch: Batch = { before: doc.snapshot(), selectionBefore: selection, selection, change: emptyChange("edit", origin), touched: false };
    this.batchState = batch;
    let value: T;
    try {
      value = fn();
    } catch (error) {
      this.batchState = null;
      doc.restore(batch.before);
      this.host.syncTracking();
      throw error;
    }
    this.batchState = null;
    if (batch.touched) {
      this.history.record({
        before: batch.before,
        selectionBefore: batch.selectionBefore,
        selectionAfter: batch.selection,
        at: this.host.now().getTime(),
      });
      this.host.commit({ ...batch.change, selection: batch.selection, selectionLost: batch.selectionBefore !== null && batch.selection === null });
    }
    return value;
  }

  /**
   * Runs a custom change as one undo step. Positions cannot follow an
   * arbitrary change, so the selection is lost unless `carrySelection` says
   * where it goes: it is called with the selection before `fn` runs and
   * returns the function that finds it afterwards (null when it is gone).
   */
  mutate<T>(
    fn: (doc: DocxDocument) => T,
    options: SessionMutateOptions & {
      effect?: (result: T) => MutationEffect | null;
      carrySelection?: (selection: SessionSelection) => (result: T) => SessionSelection | null;
    },
  ): T {
    const doc = this.host.requireDocument();
    const batch = this.batchState;
    const before = batch === null ? doc.snapshot() : null;
    const selection = batch !== null ? batch.selection : this.readSelection();
    const find = selection === null || options.carrySelection === undefined ? null : options.carrySelection(selection);
    const result = fn(doc);
    const carried = find === null ? null : this.carried(() => find(result));
    const effect = options.effect?.(result) ?? null;
    const change: DocumentChange = {
      ...emptyChange(options.kind ?? "edit", options.origin ?? null),
      full: effect === null,
      changedBlockIds: effect?.changedBlockIds ?? [],
      createdBlockIds: effect?.createdBlockIds ?? [],
      removedBlockIds: effect?.removedBlockIds ?? [],
      changedStoryIds: effect?.changedStoryIds ?? [],
      revisionIds: effect?.revisionIds ?? [],
      selection: carried,
      selectionLost: selection !== null && carried === null,
    };
    if (batch !== null) {
      batch.change = mergeChange(batch.change, change);
      batch.selection = carried;
      batch.touched = true;
      return result;
    }
    this.history.record({
      before: before as NonNullable<typeof before>,
      selectionBefore: selection,
      selectionAfter: carried,
      at: this.host.now().getTime(),
    });
    this.host.commit(change);
    return result;
  }

  travel(direction: "undo" | "redo"): boolean {
    const doc = this.host.getDocument();
    if (doc === null || this.batchState !== null) return false;
    const step = direction === "undo" ? this.history.undo(doc) : this.history.redo(doc);
    if (step === false) return false;
    this.host.syncTracking();
    this.host.commit({ ...emptyChange(direction, null), full: true, selection: step.selection });
    return true;
  }

  /** The selection a change carried, or null (lost) when finding it threw. */
  private carried(find: () => SessionSelection | null): SessionSelection | null {
    try {
      return find();
    } catch (error) {
      this.host.log("docs: the selection could not be carried through the change", error);
      return null;
    }
  }

  private readSelection(): SessionSelection | null {
    if (this.selectionSource === null) return null;
    try {
      return this.selectionSource();
    } catch (error) {
      this.host.log("docs: the selection source failed", error);
      return null;
    }
  }

  /** Revision time, to the minute: revisions made in one sitting share a stamp and group into one change. */
  private stamp(): string {
    const minute = Math.floor(this.host.now().getTime() / 60_000) * 60_000;
    return new Date(minute).toISOString().replace(".000Z", "Z");
  }
}
