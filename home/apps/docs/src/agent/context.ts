/**
 * What part of the document goes into each prompt.
 *
 * - The whole document, when it fits the budget.
 * - Otherwise, for a request about a selection or about named clauses: the
 *   outline, the selected paragraphs and the paragraphs retrieval ranks
 *   highest, each with the heading of its clause.
 * - Otherwise (a request about the whole document): the outline and one
 *   part of the document per prompt, cut at headings where possible.
 *
 * Every context is wrapped as untrusted content and knows which blocks it
 * showed, so edits to other blocks can be refused.
 */

import { MAX_CHUNKS } from "./constants";
import type { DescribedBlock, DocumentText } from "./description";
import { boundedOutline, clauseOf } from "./description";
import type { BlockId } from "./engine";
import { isTargeted, rankBlocks } from "./retrieval";
import type { RetrievalOptions } from "./retrieval";
import type { EditScope } from "./types";
import { wrapOverhead, wrapUntrusted } from "./untrusted";

export interface PromptContext {
  kind: "whole" | "focused" | "part";
  /** 1-based part number and count; 1 of 1 unless the document was cut into parts. */
  part: number;
  parts: number;
  /** The wrapped document text for the prompt. */
  text: string;
  /** Blocks the context showed. */
  blockIds: Set<BlockId>;
}

export interface ContextPlan {
  contexts: PromptContext[];
  /** True when the document had more parts than one request processes. */
  truncated: boolean;
}

export interface ContextRequest extends RetrievalOptions {
  instruction: string;
  /** Blocks the selection touches, in document order. */
  selectionBlockIds: BlockId[];
  scope: EditScope;
  /** Characters available for the document text, wrapper included. */
  budget: number;
  /** `always` uses retrieval for a long document even when the instruction names no clause (questions). Default `auto`. */
  focus?: "auto" | "always";
}

const WRAP_LABEL = "body";
const ELLIPSIS = "…";

/** Cuts a line to `max` characters; a cut line ends in an ellipsis. */
function fitLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

function wrap(body: string): string {
  return wrapUntrusted(WRAP_LABEL, body);
}

export function planContexts(text: DocumentText, request: ContextRequest): ContextPlan {
  const room = request.budget - wrapOverhead(WRAP_LABEL);
  const selected = request.selectionBlockIds.map((id) => text.byId.get(id)).filter((block): block is DescribedBlock => block !== undefined);
  const everything = text.blocks;

  if (request.scope !== "selection" && text.contentLength + "# Content\n".length <= room) {
    const body = `# Content\n${everything.map((block) => block.line).join("\n")}`;
    return { contexts: [{ kind: "whole", part: 1, parts: 1, text: wrap(body), blockIds: new Set(everything.map((block) => block.id)) }], truncated: false };
  }

  const wantsFocus =
    request.scope === "selection" ||
    (request.scope === "auto" && (request.focus === "always" || selected.length > 0 || isTargeted(text, request.instruction, request)));
  if (wantsFocus) {
    const focused = focusedContext(text, request, selected, room);
    if (focused !== null) return { contexts: [focused], truncated: false };
    // The selection alone does not fit: work through it in parts.
    if (selected.length > 0) return partContexts(text, selected, room);
  }
  return partContexts(text, everything, room);
}

/** Outline plus the most relevant paragraphs. Null when the selected paragraphs alone do not fit. */
function focusedContext(text: DocumentText, request: ContextRequest, selected: DescribedBlock[], room: number): PromptContext | null {
  const outline = boundedOutline(text, Math.floor(room * 0.25));
  const header = `# Outline\n${outline}\n# Excerpts (paragraphs in document order; others are left out)\n`;
  let left = room - header.length;
  const chosen = new Map<BlockId, DescribedBlock>();
  const take = (block: DescribedBlock, required: boolean): boolean => {
    if (chosen.has(block.id)) return true;
    const cost = block.line.length + 1;
    if (cost > left) return !required;
    chosen.set(block.id, block);
    left -= cost;
    return true;
  };
  const headingOf = (block: DescribedBlock): DescribedBlock | null =>
    block.clause >= 0 && block.clause !== block.order ? (text.blocks[block.clause] as DescribedBlock) : null;

  for (const block of selected) {
    if (!take(block, true)) return null;
  }
  for (const block of selected) {
    const heading = headingOf(block);
    if (heading !== null) take(heading, false);
  }
  for (const block of rankBlocks(text, request.instruction, request)) {
    const heading = headingOf(block);
    if (heading !== null) take(heading, false);
    take(block, false);
    if (left <= 0) break;
  }
  // Fill what is left with the rest of the selection's clauses, for context.
  for (const block of selected) {
    for (const member of clauseOf(text, block)) take(member, false);
  }
  if (chosen.size === 0) return null;
  const lines = [...chosen.values()].sort((a, b) => a.order - b.order).map((block) => block.line);
  return { kind: "focused", part: 1, parts: 1, text: wrap(`${header}${lines.join("\n")}`), blockIds: new Set(chosen.keys()) };
}

/** The given paragraphs cut into parts that each fit with the outline. */
function partContexts(text: DocumentText, blocks: DescribedBlock[], room: number): ContextPlan {
  const outline = boundedOutline(text, Math.floor(room * 0.2));
  const headerFor = (part: number, parts: number) => `# Outline\n${outline}\n# Part ${part} of ${parts}\n`;
  // The longest header the parts can have (the counts are filled in afterwards).
  const lineRoom = Math.max(64, room - headerFor(MAX_CHUNKS * 100, MAX_CHUNKS * 100).length);

  const groups: DescribedBlock[][] = [];
  const lines: string[][] = [];
  let current: DescribedBlock[] = [];
  let currentLines: string[] = [];
  let used = 0;
  const close = () => {
    if (current.length === 0) return;
    groups.push(current);
    lines.push(currentLines);
    current = [];
    currentLines = [];
    used = 0;
  };
  for (const block of blocks) {
    const line = fitLine(block.line, lineRoom - 1);
    const cost = line.length + 1;
    const startsClause = block.headingLevel > 0 && used >= lineRoom * 0.5;
    if (used + cost > lineRoom || startsClause) close();
    current.push(block);
    currentLines.push(line);
    used += cost;
  }
  close();

  const truncated = groups.length > MAX_CHUNKS;
  const count = Math.min(groups.length, MAX_CHUNKS);
  const contexts: PromptContext[] = [];
  for (let i = 0; i < count; i++) {
    const group = groups[i] as DescribedBlock[];
    const body = `${headerFor(i + 1, count)}${(lines[i] as string[]).join("\n")}`;
    contexts.push({ kind: "part", part: i + 1, parts: count, text: wrap(body), blockIds: new Set(group.map((block) => block.id)) });
  }
  return { contexts, truncated };
}
