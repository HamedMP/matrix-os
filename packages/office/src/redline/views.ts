/**
 * The three views of a tracked document as blocks of runs, ready to render.
 *
 * `original` and `final` read one side. `markup` shows both: a block takes
 * its place and its elements from the final side when any of its content is
 * on that side, and from the original side when it is deleted text only. A
 * deleted block boundary between two blocks that both survive is shown as a
 * marker inside one joined block, the way the final text reads.
 */

import type { RedlineMode } from "../api/redline.js";
import { RUN_MARKER, type RenderBlock, type RenderRun } from "./html-render.js";
import { KIND_BLOCK, plainText, type ChangeRecord, type Item } from "./model.js";

export function viewText(items: readonly Item[], mode: RedlineMode): string {
  let out = "";
  for (const item of items) {
    if (mode === "original" && item.a === null) continue;
    if (mode === "final" && item.b === null) continue;
    out += plainText(item);
  }
  return out;
}

function sideBlocks(items: readonly Item[], side: "a" | "b"): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let runs: RenderRun[] = [];
  for (const item of items) {
    const p = item[side];
    if (p === null) continue;
    if (item.k === KIND_BLOCK) {
      runs = [];
      blocks.push({ chain: p, runs });
    } else {
      runs.push({ k: item.k, t: item.t, p, change: null });
    }
  }
  return blocks;
}

interface RawBlock {
  boundary: Item;
  content: Item[];
  /** Chain in force on each side from this boundary on. */
  aChain: string;
  bChain: string;
  hasA: boolean;
  hasB: boolean;
}

function markupBlocks(items: readonly Item[], changes: ReadonlyMap<string, ChangeRecord>): RenderBlock[] {
  const raw: RawBlock[] = [];
  let aChain = "";
  let bChain = "";
  for (const item of items) {
    if (item.k === KIND_BLOCK) {
      if (item.a !== null) aChain = item.a;
      if (item.b !== null) bChain = item.b;
      raw.push({ boundary: item, content: [], aChain, bChain, hasA: false, hasB: false });
      continue;
    }
    const current = raw[raw.length - 1] as RawBlock;
    current.content.push(item);
    if (item.a !== null) current.hasA = true;
    if (item.b !== null) current.hasB = true;
  }
  const blocks: RenderBlock[] = [];
  let runs: RenderRun[] = [];
  raw.forEach((block, index) => {
    const boundary = block.boundary;
    const change = boundary.c === null ? null : (changes.get(boundary.c) ?? null);
    const previous = raw[index - 1];
    // A deleted boundary between two blocks that both keep text joins them, as in the final text.
    const joined = previous !== undefined && boundary.b === null && previous.hasB && block.hasB;
    if (!joined) {
      runs = [];
      const chain = block.hasB ? block.bChain : block.hasA ? block.aChain : (boundary.b ?? boundary.a ?? "");
      blocks.push({ chain, runs });
    }
    if (change) runs.push({ k: RUN_MARKER, t: "", p: "", change });
    for (const item of block.content) {
      runs.push({ k: item.k, t: item.t, p: item.b ?? item.a ?? "", change: item.c === null ? null : (changes.get(item.c) ?? null) });
    }
  });
  return blocks;
}

export function viewBlocks(items: readonly Item[], mode: RedlineMode, changes: ReadonlyMap<string, ChangeRecord>): RenderBlock[] {
  if (mode === "original") return sideBlocks(items, "a");
  if (mode === "final") return sideBlocks(items, "b");
  return markupBlocks(items, changes);
}
