/**
 * The block-level plan of a comparison: which paragraphs and tables of the
 * two versions belong together, in the order they appear in the result.
 *
 * Paragraph marks decide how the plan is written. A deleted paragraph has a
 * deleted mark and runs on into the paragraph after it once the change is
 * accepted; an inserted one has an inserted mark and does the same when the
 * change is rejected. That only works while a paragraph follows, so the
 * changes at the end of a stretch of paragraphs (before a table, a section
 * break or the end of the container) are rewritten by `settleMarks` so that
 * the last paragraph of the stretch has a mark both versions keep.
 */

import { diffParagraphs } from "../../redline/index.js";
import { blockKey } from "./extract.js";
import type { BlockNode, ContentKind, ParaNode, RowNode, TableNode } from "./types.js";

/** One half of a relocated paragraph: the name both halves share and the paragraph on the other side. */
export interface MoveLink {
  readonly name: string;
  readonly partner: ParaNode;
}

export interface ParagraphEntry {
  type: "paragraphs";
  /** Paragraphs of the original this entry covers, in order. */
  a: ParaNode[];
  /** Paragraphs of the revised version this entry covers, in order. */
  b: ParaNode[];
  /** `diff`: the texts are compared word by word. `replace`: all of `a` goes and all of `b` comes. */
  mode: "diff" | "replace";
  /** How content of `a` that is gone is marked. */
  removal: "del" | "moveFrom";
  /** How content of `b` that is new is marked. */
  addition: "ins" | "moveTo";
  /** Revision of the mark of the entry's last paragraph element; null for a mark both versions keep. */
  mark: ContentKind | null;
  moveFrom: MoveLink | null;
  moveTo: MoveLink | null;
}

export interface TableEntry {
  type: "table";
  a: TableNode | null;
  b: TableNode | null;
}

export type Entry = ParagraphEntry | TableEntry;

export interface RowPair {
  a: RowNode | null;
  b: RowNode | null;
}

function paired(a: ParaNode[], b: ParaNode[]): ParagraphEntry {
  return { type: "paragraphs", a, b, mode: "diff", removal: "del", addition: "ins", mark: null, moveFrom: null, moveTo: null };
}

function removed(block: BlockNode, move: MoveLink | null = null): Entry {
  if (block.kind === "table") return { type: "table", a: block, b: null };
  const removal = move === null ? "del" : "moveFrom";
  return { type: "paragraphs", a: [block], b: [], mode: "diff", removal, addition: "ins", mark: removal, moveFrom: move, moveTo: null };
}

function added(block: BlockNode, move: MoveLink | null = null): Entry {
  if (block.kind === "table") return { type: "table", a: null, b: block };
  const addition = move === null ? "ins" : "moveTo";
  return { type: "paragraphs", a: [], b: [block], mode: "diff", removal: "del", addition, mark: addition, moveFrom: null, moveTo: move };
}

function allParagraphs(blocks: readonly BlockNode[]): blocks is ParaNode[] {
  return blocks.every((block) => block.kind === "paragraph");
}

function defaultMark(entry: ParagraphEntry): ContentKind {
  return entry.b.length === 0 ? entry.removal : entry.addition;
}

/** Rewrites the changes at the end of one stretch of paragraphs; see the file comment. */
function settleRun(run: ParagraphEntry[]): ParagraphEntry[] {
  let anchor = -1;
  for (let position = 0; position < run.length; position++) {
    const entry = run[position] as ParagraphEntry;
    if (entry.a.length > 0 && entry.b.length > 0) anchor = position;
  }
  const tail = run.slice(anchor + 1);
  if (tail.length === 0) return run;
  const removals = tail.filter((entry) => entry.b.length === 0);
  const additions = tail.filter((entry) => entry.a.length === 0);
  const lastRemoval = removals[removals.length - 1];
  const lastAddition = additions[additions.length - 1];
  if (lastRemoval !== undefined && lastAddition !== undefined) {
    // The last paragraph that goes and the last that comes share one element: its mark is in both versions.
    const merged: ParagraphEntry = {
      type: "paragraphs",
      a: lastRemoval.a,
      b: lastAddition.b,
      mode: "replace",
      removal: lastRemoval.removal,
      addition: lastAddition.addition,
      mark: null,
      moveFrom: lastRemoval.moveFrom,
      moveTo: lastAddition.moveTo,
    };
    return [...run.slice(0, anchor + 1), ...removals.slice(0, -1), ...additions.slice(0, -1), merged];
  }
  if (anchor >= 0) {
    // Every mark moves one paragraph up, so the kept mark ends the stretch.
    const chain = [run[anchor] as ParagraphEntry, ...tail];
    for (let position = 0; position < chain.length - 1; position++) {
      (chain[position] as ParagraphEntry).mark = defaultMark(chain[position + 1] as ParagraphEntry);
    }
    (chain[chain.length - 1] as ParagraphEntry).mark = null;
  }
  return run;
}

function settleMarks(entries: readonly Entry[]): Entry[] {
  const settled: Entry[] = [];
  let run: ParagraphEntry[] = [];
  const flush = (): void => {
    settled.push(...settleRun(run));
    run = [];
  };
  for (const entry of entries) {
    if (entry.type === "table") {
      flush();
      settled.push(entry);
      continue;
    }
    run.push(entry);
    if (entry.a[entry.a.length - 1]?.endsSection === true) flush();
  }
  flush();
  return settled;
}

/**
 * Aligns the blocks of two containers. `moveName` supplies a name for each
 * relocated paragraph.
 */
export function planBlocks(a: readonly BlockNode[], b: readonly BlockNode[], detectMoves: boolean, moveName: () => string): Entry[] {
  const entries: Entry[] = [];
  const names = new Map<string, string>();
  const nameOf = (moveId: string | null, offset: number): string => {
    const key = `${moveId ?? ""}:${offset}`;
    let name = names.get(key);
    if (name === undefined) {
      name = moveName();
      names.set(key, name);
    }
    return name;
  };
  for (const op of diffParagraphs(a.map(blockKey), b.map(blockKey), { detectMoves })) {
    const left = a.slice(op.aStart, op.aEnd);
    const right = b.slice(op.bStart, op.bEnd);
    switch (op.type) {
      case "equal":
        left.forEach((block, offset) => {
          const other = right[offset] as BlockNode;
          if (block.kind === "paragraph" && other.kind === "paragraph") entries.push(paired([block], [other]));
          else if (block.kind === "table" && other.kind === "table") entries.push({ type: "table", a: block, b: other });
          else entries.push(removed(block), added(other));
        });
        break;
      case "modify":
      case "split":
      case "merge": {
        const first = left[0];
        const second = right[0];
        if (allParagraphs(left) && allParagraphs(right)) entries.push(paired(left, right));
        else if (left.length === 1 && right.length === 1 && first?.kind === "table" && second?.kind === "table") {
          entries.push({ type: "table", a: first, b: second });
        } else {
          for (const block of left) entries.push(removed(block));
          for (const block of right) entries.push(added(block));
        }
        break;
      }
      case "delete":
        for (const block of left) entries.push(removed(block));
        break;
      case "insert":
        for (const block of right) entries.push(added(block));
        break;
      case "moveFrom":
        left.forEach((block, offset) => {
          const partner = op.peer === null ? undefined : b[op.peer.start + offset];
          if (block.kind === "paragraph" && partner?.kind === "paragraph") {
            entries.push(removed(block, { name: nameOf(op.moveId, offset), partner }));
          } else entries.push(removed(block));
        });
        break;
      case "moveTo":
        right.forEach((block, offset) => {
          const partner = op.peer === null ? undefined : a[op.peer.start + offset];
          if (block.kind === "paragraph" && partner?.kind === "paragraph") {
            entries.push(added(block, { name: nameOf(op.moveId, offset), partner }));
          } else entries.push(added(block));
        });
        break;
      default:
        break;
    }
  }
  return settleMarks(entries);
}

/** Aligns the rows of two tables. Rows pair only when they have the same number of cells. */
export function planRows(a: readonly RowNode[], b: readonly RowNode[]): RowPair[] {
  const pairs: RowPair[] = [];
  const ops = diffParagraphs(
    a.map((row) => row.text),
    b.map((row) => row.text),
    { detectMoves: false },
  );
  for (const op of ops) {
    const left = a.slice(op.aStart, op.aEnd);
    const right = b.slice(op.bStart, op.bEnd);
    const sameShape = left.length === right.length && left.every((row, offset) => row.cells.length === right[offset]?.cells.length);
    if ((op.type === "equal" || op.type === "modify") && sameShape) {
      left.forEach((row, offset) => pairs.push({ a: row, b: right[offset] as RowNode }));
    } else {
      for (const row of left) pairs.push({ a: row, b: null });
      for (const row of right) pairs.push({ a: null, b: row });
    }
  }
  return pairs;
}
