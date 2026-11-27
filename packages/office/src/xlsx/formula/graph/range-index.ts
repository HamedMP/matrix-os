/**
 * Finds the ranges of one sheet that contain a cell.
 *
 * Ranges are filed in grids of blocks, from fine to coarse, so that a
 * lookup reads the few ranges near the cell instead of every range of the
 * sheet. The fine grids are one column wide: a column of running totals
 * (`SUM(A$1:A1)`, `SUM(A$1:A2)`, …) is then only looked at for cells of
 * that column. A range that would fill too many blocks of the coarsest grid
 * (a whole column, a whole row) is kept in a short list that every lookup
 * scans.
 */

export interface Rect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface RangeEntry<T> extends Rect {
  /** Whatever the owner attaches to the range. */
  readonly owners: Set<T>;
  /** Grid the entry is filed in, or -1 for the scanned list. */
  level: number;
}

interface Grid {
  readonly rows: number;
  readonly cols: number;
  /** Multiplier that keeps block ids of one grid apart. */
  readonly stride: number;
  readonly blocks: Map<number, Set<RangeEntry<unknown>>>;
}

/** A range filed in more blocks than this moves to the next coarser grid. */
const MAX_BLOCKS_PER_RANGE = 64;
const GRID_SIZES: ReadonlyArray<{ rows: number; cols: number }> = [
  { rows: 64, cols: 1 },
  { rows: 4096, cols: 1 },
  { rows: 4096, cols: 256 },
];
const LAST_COL = 16_383;

function rectKey(rect: Rect): string {
  return `${rect.startRow},${rect.startCol},${rect.endRow},${rect.endCol}`;
}

export function rectContains(rect: Rect, row: number, col: number): boolean {
  return row >= rect.startRow && row <= rect.endRow && col >= rect.startCol && col <= rect.endCol;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol;
}

export class RangeIndex<T> {
  // One entry per distinct rectangle; the owner bounds the number of ranges through its formula limit.
  private readonly entries = new Map<string, RangeEntry<T>>();
  private readonly grids: Grid[] = GRID_SIZES.map((size) => ({
    ...size,
    stride: Math.floor(LAST_COL / size.cols) + 1,
    blocks: new Map<number, Set<RangeEntry<unknown>>>(),
  }));
  private readonly scanned = new Set<RangeEntry<T>>();

  get size(): number {
    return this.entries.size;
  }

  /** Attaches an owner to a rectangle, filing the rectangle when it is new. */
  add(rect: Rect, owner: T): RangeEntry<T> {
    const key = rectKey(rect);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        startRow: rect.startRow,
        startCol: rect.startCol,
        endRow: rect.endRow,
        endCol: rect.endCol,
        owners: new Set<T>(),
        level: -1,
      };
      this.entries.set(key, entry);
      this.file(entry);
    }
    entry.owners.add(owner);
    return entry;
  }

  /** Detaches an owner; a rectangle without owners is removed. */
  remove(entry: RangeEntry<T>, owner: T): void {
    entry.owners.delete(owner);
    if (entry.owners.size > 0) return;
    this.entries.delete(rectKey(entry));
    if (entry.level === -1) {
      this.scanned.delete(entry);
      return;
    }
    const grid = this.grids[entry.level] as Grid;
    this.eachBlock(grid, entry, (id) => {
      const block = grid.blocks.get(id);
      if (block === undefined) return;
      block.delete(entry as RangeEntry<unknown>);
      if (block.size === 0) grid.blocks.delete(id);
    });
  }

  /** Calls `visit` for every rectangle that contains the cell. */
  containing(row: number, col: number, visit: (entry: RangeEntry<T>) => void): void {
    for (const grid of this.grids) {
      const block = grid.blocks.get(Math.floor(row / grid.rows) * grid.stride + Math.floor(col / grid.cols));
      if (block === undefined) continue;
      for (const entry of block) {
        if (rectContains(entry, row, col)) visit(entry as RangeEntry<T>);
      }
    }
    for (const entry of this.scanned) {
      if (rectContains(entry, row, col)) visit(entry);
    }
  }

  /** Calls `visit` for every rectangle that shares a cell with `rect`. Reads every rectangle of the sheet. */
  intersecting(rect: Rect, visit: (entry: RangeEntry<T>) => void): void {
    for (const entry of this.entries.values()) {
      if (rectsIntersect(entry, rect)) visit(entry);
    }
  }

  clear(): void {
    this.entries.clear();
    this.scanned.clear();
    for (const grid of this.grids) grid.blocks.clear();
  }

  private file(entry: RangeEntry<T>): void {
    for (let level = 0; level < this.grids.length; level += 1) {
      const grid = this.grids[level] as Grid;
      const rowBlocks = Math.floor(entry.endRow / grid.rows) - Math.floor(entry.startRow / grid.rows) + 1;
      const colBlocks = Math.floor(entry.endCol / grid.cols) - Math.floor(entry.startCol / grid.cols) + 1;
      if (rowBlocks * colBlocks > MAX_BLOCKS_PER_RANGE) continue;
      entry.level = level;
      this.eachBlock(grid, entry, (id) => {
        let block = grid.blocks.get(id);
        if (block === undefined) {
          block = new Set<RangeEntry<unknown>>();
          grid.blocks.set(id, block);
        }
        block.add(entry as RangeEntry<unknown>);
      });
      return;
    }
    entry.level = -1;
    this.scanned.add(entry);
  }

  private eachBlock(grid: Grid, rect: Rect, visit: (id: number) => void): void {
    const lastRow = Math.floor(rect.endRow / grid.rows);
    const lastCol = Math.floor(rect.endCol / grid.cols);
    for (let r = Math.floor(rect.startRow / grid.rows); r <= lastRow; r += 1) {
      for (let c = Math.floor(rect.startCol / grid.cols); c <= lastCol; c += 1) visit(r * grid.stride + c);
    }
  }
}
