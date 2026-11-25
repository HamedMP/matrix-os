/**
 * Writes a view of a document as HTML.
 *
 * Only this module produces markup, and it produces only the allowed
 * elements, an `href` that passed {@link safeHref}, and the `ins`/`del`
 * wrappers with escaped attribute values. All text is escaped.
 */

import type { ChangeRecord } from "./model.js";
import { KIND_BREAK, KIND_TEXT, escapeHtml, splitInline, type ItemKind } from "./model.js";

/** A run that only marks a changed block boundary: an empty `ins` or `del`. */
export const RUN_MARKER = 3;

export interface RenderRun {
  k: ItemKind | typeof RUN_MARKER;
  t: string;
  /** Inline presentation string. */
  p: string;
  change: ChangeRecord | null;
}

export interface RenderBlock {
  /** Block chain, see `model.ts`. Two neighbouring blocks with the same chain are separated by a line break. */
  chain: string;
  runs: RenderRun[];
}

const CHANGE_CLASS = {
  insert: "redline-ins",
  delete: "redline-del",
  moveFrom: "redline-move-from",
  moveTo: "redline-move-to",
} as const;

function changeElement(change: ChangeRecord): "ins" | "del" {
  return change.kind === "insert" || change.kind === "moveTo" ? "ins" : "del";
}

function changeOpen(change: ChangeRecord, marker: boolean): string {
  const cls = CHANGE_CLASS[change.kind] + (marker ? " redline-para" : "");
  return (
    `<${changeElement(change)} class="${cls}" data-change-id="${escapeHtml(change.id)}"` +
    ` data-author="${escapeHtml(change.author)}" data-date="${escapeHtml(change.date)}">`
  );
}

interface Wrapper {
  open: string;
  close: string;
}

function wrappers(run: RenderRun): Wrapper[] {
  const out: Wrapper[] = [];
  if (run.change) out.push({ open: changeOpen(run.change, false), close: `</${changeElement(run.change)}>` });
  const { tags, href } = splitInline(run.p);
  for (const tag of tags) {
    const open = tag === "a" && href !== null ? `<a href="${escapeHtml(href)}">` : `<${tag}>`;
    out.push({ open, close: `</${tag}>` });
  }
  return out;
}

function renderRuns(runs: readonly RenderRun[], textFormat: boolean, out: string[]): void {
  let open: Wrapper[] = [];
  const closeFrom = (keep: number): void => {
    for (let i = open.length - 1; i >= keep; i -= 1) out.push((open[i] as Wrapper).close);
    open.length = keep;
  };
  for (const run of runs) {
    if (run.k === RUN_MARKER) {
      closeFrom(0);
      if (run.change) out.push(changeOpen(run.change, true), `</${changeElement(run.change)}>`);
      continue;
    }
    const wanted = wrappers(run);
    let same = 0;
    while (same < open.length && same < wanted.length && (open[same] as Wrapper).open === (wanted[same] as Wrapper).open) same += 1;
    closeFrom(same);
    for (let i = same; i < wanted.length; i += 1) out.push((wanted[i] as Wrapper).open);
    open = wanted;
    if (run.k === KIND_BREAK) out.push("<br>");
    else if (run.k === KIND_TEXT) out.push(textFormat ? escapeHtml(run.t).replace(/\r\n|\r|\n/g, "<br>") : escapeHtml(run.t));
  }
  closeFrom(0);
}

/** Renders blocks, opening and closing the block elements their chains name. */
export function renderBlocks(blocks: readonly RenderBlock[], textFormat: boolean): string {
  const out: string[] = [];
  let open: string[] = [];
  let previous: string | null = null;
  for (const block of blocks) {
    const chain = block.chain === "" ? [] : block.chain.split("/");
    let same = 0;
    while (same < open.length && same < chain.length && open[same] === chain[same]) same += 1;
    if (previous !== null && block.chain === previous) {
      // Two blocks in the same element: only a line break can tell them apart.
      out.push("<br>");
    } else {
      for (let i = open.length - 1; i >= same; i -= 1) out.push(`</${tagOf(open[i] as string)}>`);
      for (let i = same; i < chain.length; i += 1) out.push(`<${tagOf(chain[i] as string)}>`);
      open = chain;
    }
    renderRuns(block.runs, textFormat, out);
    previous = block.chain;
  }
  for (let i = open.length - 1; i >= 0; i -= 1) out.push(`</${tagOf(open[i] as string)}>`);
  return out.join("");
}

function tagOf(entry: string): string {
  const colon = entry.indexOf(":");
  return colon === -1 ? entry : entry.slice(0, colon);
}
