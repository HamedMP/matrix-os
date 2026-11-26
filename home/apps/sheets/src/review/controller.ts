/**
 * Change review for one open spreadsheet: which change is current, which are
 * selected, the markup layer on the grid, and accepting or rejecting.
 *
 * The session recalculates after every accept or reject, so dependants show
 * their new values as soon as a change is resolved.
 */

import type { CellDecoration } from "../grid";
import type { SessionEvent } from "../session";
import type { CellAddress, CellRange, ResolveChangesResult, SheetId, Workbook } from "./engine";
import { isOfficeError } from "./engine";
import { type ReviewGroup, type ReviewItem, buildReviewGroups, markupDecorations, reviewOrder } from "./model";

/** The decoration layer the markup view owns. */
export const MARKUP_LAYER = "review-markup";
const MAX_LISTENERS = 32;

/** The parts of `SheetSession` review uses. */
export interface ReviewSession {
  readonly workbook: Workbook;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  acceptChanges(ids: readonly string[] | "all"): ResolveChangesResult;
  rejectChanges(ids: readonly string[] | "all"): ResolveChangesResult;
}

/** The parts of `SheetGridController` review uses. */
export interface ReviewGrid {
  select(target: CellAddress | CellRange, sheet?: SheetId): void;
  scrollTo(cell: CellAddress, sheet?: SheetId): void;
  decorate(layer: string, decorations: readonly CellDecoration[]): void;
  clearDecorations(layer?: string): void;
  /** Runs a change of cells once the text still in the cell editor is stored; false when the editor refused it. */
  afterEdit?(command: () => void): boolean;
}

export interface ReviewState {
  groups: ReviewGroup[];
  /** Every change in stepping order. */
  items: ReviewItem[];
  total: number;
  /** Position of the current change in `items`, or -1. */
  index: number;
  currentId: string | null;
  current: ReviewItem | null;
  selectedIds: string[];
  markup: boolean;
  /** A sentence for the owner after an action that did not fully succeed, or null. */
  notice: string | null;
}

export type ReviewTarget = readonly string[] | "all" | "selection" | "current";
export type ReviewActionResult = { ok: true; resolved: number } | { ok: false; message: string };

const STALE_NOTICE = "Some changes stay pending because their cells were edited since they were proposed. Accept them to keep the current content.";
const GONE_NOTICE = "That change is no longer pending. The list has been refreshed.";
const FAILED_NOTICE = "The change could not be resolved. Try again.";
/** Returned, not shown: the cell editor shows why it refused its text. */
const EDITING_NOTICE = "Finish the cell being edited first.";

export class SheetReviewController {
  private grid: ReviewGrid | null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private state: ReviewState;
  private markupOn = false;
  private disposed = false;

  constructor(
    private readonly session: ReviewSession,
    grid: ReviewGrid | null = null,
    private readonly log: (message: string, error: unknown) => void = () => undefined,
  ) {
    this.grid = grid;
    this.state = this.build(null, [], null, -1);
    this.attach();
  }

  /**
   * Follows the session's changes; the constructor does this. After
   * `dispose`, attaching again reads the journal again and resumes, so a
   * component can dispose in an effect's cleanup and attach in its setup.
   */
  attach(): void {
    if (this.unsubscribe !== null) return;
    this.disposed = false;
    this.unsubscribe = this.session.subscribe((event) => {
      if (event.type === "change") this.refresh();
    });
    this.refresh();
  }

  getState(): ReviewState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error("too many review listeners");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Attaches or replaces the grid that shows markup and receives navigation. */
  setGrid(grid: ReviewGrid | null): void {
    if (this.grid === grid) return;
    this.grid?.clearDecorations(MARKUP_LAYER);
    this.grid = grid;
    this.paintMarkup();
  }

  /** Reads the journal again. Called on every session change. */
  refresh(): void {
    if (this.disposed) return;
    const s = this.state;
    this.state = this.build(s.currentId, s.selectedIds, s.notice, s.index);
    this.paintMarkup();
    this.emit();
  }

  // ------------------------------------------------------------ markup

  setMarkup(on: boolean): void {
    if (this.markupOn === on) return;
    this.markupOn = on;
    this.state = { ...this.state, markup: on };
    this.paintMarkup();
    this.emit();
  }

  toggleMarkup(): void {
    this.setMarkup(!this.markupOn);
  }

  private paintMarkup(): void {
    if (this.grid === null || this.disposed) return;
    const decorations = this.markupOn ? markupDecorations(this.state.items) : [];
    if (decorations.length === 0) this.grid.clearDecorations(MARKUP_LAYER);
    else this.grid.decorate(MARKUP_LAYER, decorations);
  }

  // ------------------------------------------------------------ navigation

  next(): void {
    this.step(1);
  }

  previous(): void {
    this.step(-1);
  }

  private step(direction: 1 | -1): void {
    const total = this.state.items.length;
    if (total === 0) return;
    const from = this.state.index;
    const index = from < 0 ? (direction === 1 ? 0 : total - 1) : (from + direction + total) % total;
    this.moveTo(index);
  }

  /** Makes a change current and brings its cell into view. */
  goTo(id: string): void {
    const index = this.state.items.findIndex((item) => item.id === id);
    if (index >= 0) this.moveTo(index);
  }

  private moveTo(index: number): void {
    const item = this.state.items[index];
    if (item === undefined) return;
    this.state = { ...this.state, index, currentId: item.id, current: item, notice: null };
    this.reveal(item);
    this.emit();
  }

  private reveal(item: ReviewItem): void {
    if (this.grid === null) return;
    try {
      if (item.kind === "cell") this.grid.select({ row: item.row, col: item.col }, item.sheet);
      else this.grid.scrollTo({ row: Math.max(0, item.row), col: Math.max(0, item.col) }, item.sheet);
    } catch (error: unknown) {
      // A change on a sheet that is gone: the list refreshes on the next session change.
      this.log("review could not reveal a change", error);
    }
  }

  // ------------------------------------------------------------ selection

  toggleSelected(id: string, on?: boolean): void {
    const selected = new Set(this.state.selectedIds);
    const wanted = on ?? !selected.has(id);
    if (wanted) selected.add(id);
    else selected.delete(id);
    this.setSelected([...selected]);
  }

  setSelected(ids: readonly string[]): void {
    const known = new Set(this.state.items.map((item) => item.id));
    const wanted = new Set(ids);
    const selectedIds = this.state.items.filter((item) => wanted.has(item.id) && known.has(item.id)).map((item) => item.id);
    this.state = { ...this.state, selectedIds };
    this.emit();
  }

  clearSelection(): void {
    this.setSelected([]);
  }

  // ------------------------------------------------------------ resolving

  acceptCurrent(): ReviewActionResult {
    return this.accept("current");
  }

  rejectCurrent(): ReviewActionResult {
    return this.reject("current");
  }

  accept(target: ReviewTarget): ReviewActionResult {
    return this.resolve(target, true);
  }

  reject(target: ReviewTarget): ReviewActionResult {
    return this.resolve(target, false);
  }

  private idsFor(target: ReviewTarget): readonly string[] | "all" {
    if (target === "all") return "all";
    if (target === "selection") return this.state.selectedIds;
    if (target === "current") return this.state.currentId === null ? [] : [this.state.currentId];
    return target;
  }

  /** Resolving changes cells: the text still in the cell editor goes in first, and a refused one stops it. */
  private resolve(target: ReviewTarget, accept: boolean): ReviewActionResult {
    const grid = this.grid;
    if (grid === null || grid.afterEdit === undefined) return this.resolveNow(target, accept);
    let outcome: ReviewActionResult = { ok: false, message: EDITING_NOTICE };
    grid.afterEdit(() => {
      outcome = this.resolveNow(target, accept);
    });
    return outcome;
  }

  private resolveNow(target: ReviewTarget, accept: boolean): ReviewActionResult {
    if (this.disposed) return { ok: false, message: FAILED_NOTICE };
    const ids = this.idsFor(target);
    if (ids !== "all" && ids.length === 0) return { ok: true, resolved: 0 };
    if (ids === "all" && this.state.items.length === 0) return { ok: true, resolved: 0 };
    let result: ResolveChangesResult;
    try {
      result = accept ? this.session.acceptChanges(ids) : this.session.rejectChanges(ids);
    } catch (error: unknown) {
      const gone = isOfficeError(error) && error.code === "stale_reference";
      if (!gone) this.log("resolving review changes failed", error);
      const message = gone ? GONE_NOTICE : FAILED_NOTICE;
      this.state = { ...this.state, notice: message };
      this.refresh();
      return { ok: false, message };
    }
    const resolved = new Set(result.resolvedIds);
    const notice = result.stale.length > 0 ? STALE_NOTICE : null;
    const s = this.state;
    this.state = this.build(s.currentId, s.selectedIds.filter((id) => !resolved.has(id)), notice, s.index);
    if (target === "selection") this.state = { ...this.state, selectedIds: [] };
    this.paintMarkup();
    this.emit();
    return { ok: true, resolved: resolved.size };
  }

  // ------------------------------------------------------------ state

  /**
   * Rebuilds the state from the journal. The current change stays current
   * while it is pending; when it was resolved, the change that took its
   * place in the order becomes current, so stepping continues from there.
   */
  private build(currentId: string | null, selectedIds: readonly string[], notice: string | null, previousIndex: number): ReviewState {
    const groups = buildReviewGroups(this.session.workbook);
    const items = reviewOrder(groups);
    let index = currentId === null ? -1 : items.findIndex((item) => item.id === currentId);
    if (index < 0 && currentId !== null && items.length > 0) index = Math.min(previousIndex, items.length - 1);
    const current = index >= 0 ? (items[index] ?? null) : null;
    const pending = new Set(items.map((item) => item.id));
    return {
      groups,
      items,
      total: items.length,
      index: current === null ? -1 : index,
      currentId: current?.id ?? null,
      current,
      selectedIds: selectedIds.filter((id) => pending.has(id)),
      markup: this.markupOn,
      notice,
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error: unknown) {
        this.log("a review listener failed", error);
      }
    }
  }

  /** Stops following the session and clears the markup. `attach` resumes. */
  dispose(): void {
    if (this.disposed) return;
    this.grid?.clearDecorations(MARKUP_LAYER);
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
