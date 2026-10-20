import { z } from "zod/v4";
import { citeText, clean, cutTo, oneLine, permalinkLines, PROJECT_REF_INPUT, type BrainReadAnswer } from "./brain-read-format.js";
import { BRAIN_AGENT_TEXT_MAX_CHARS, type BrainDocumentView } from "./brain-read-types.js";

// brain_document: a bounded slice of one document another brain tool returned, so a "why" answer can quote the
// paragraph that holds the reason instead of a short snippet.

export const BRAIN_DOCUMENT_ID = /^[a-f0-9]{64}$/;
/** Room for the header and the footer lines. */
const FRAME_CHARS = 1_400;
const TEXT_CHARS = BRAIN_AGENT_TEXT_MAX_CHARS.brain_document - FRAME_CHARS;
/** The opening always shown before the best matching parts. */
const OPENING_CHARS = 2_500;
const MAX_TERMS = 24;
const BODY_INDENT = "  ";
const GAP = `${BODY_INDENT}[...]`;
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "was", "were", "why", "how", "what", "when", "where", "who", "which", "did", "does",
  "this", "that", "with", "from", "into", "our", "its", "has", "have", "had", "not", "but", "you", "can", "will",
  "about", "they", "them", "their", "there", "then", "than", "been", "being", "use", "used", "cite", "source",
  "sources", "reason", "reasons", "choose", "chose", "chosen", "decide", "decided", "matrix",
]);

export const BRAIN_DOCUMENT_DESCRIPTION =
  "Read the text of one Company Brain document that brain_search or brain_claims returned, by the \"Document id\" " +
  "printed under it. With query, shows the opening and the parts that best match those words; with offset, the text " +
  "from that character on. Read-only. Use it to find the reason or detail a short match leaves out.";

export const BRAIN_DOCUMENT_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  id: z.string().regex(BRAIN_DOCUMENT_ID).describe("The Document id printed by brain_search or brain_claims"),
  query: z.string().trim().min(1).max(500).refine((value) => !value.includes("\0")).optional()
    .describe("Key words of the question; the parts that match them best are shown"),
  offset: z.number().int().min(0).max(1_000_000).optional()
    .describe("Character to read on from, as a previous brain_document answer printed"),
};

interface Part { readonly start: number; readonly text: string; readonly heading: string }

/** Lowercase words of three or more letters (a joined word also by its parts), without common question words. */
export function queryTerms(query: string): string[] {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
    .flatMap((word) => (/[_-]/.test(word) ? [word, ...word.split(/[_-]+/)] : [word]));
  return [...new Set(words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))].slice(0, MAX_TERMS);
}

const HEADING = /^#{1,6}\s/;

/** Paragraphs (split on blank lines) with their start and the latest markdown heading above them. */
function paragraphs(body: string): Part[] {
  const parts: Part[] = [];
  let heading = "";
  for (const match of body.matchAll(/[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g)) {
    const text = match[0].trimEnd();
    if (text.trim().length === 0) continue;
    if (HEADING.test(text)) heading = text.split("\n")[0]!;
    parts.push({ start: match.index, text, heading });
  }
  return parts;
}

function score(part: Part, terms: readonly string[]): number {
  const text = part.text.toLowerCase();
  const heading = part.heading.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (text.includes(term)) total += 2;
    else if (heading.includes(term)) total += 1;
  }
  return total;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `${BODY_INDENT}${line}`).join("\n");
}

/** The index of the one-line heading right above `index`'s section, or -1. */
function headingAbove(all: readonly Part[], index: number): number {
  if (HEADING.test(all[index]!.text)) return -1;
  for (let at = index - 1; at >= 0; at -= 1) {
    if (HEADING.test(all[at]!.text)) return all[at]!.text.includes("\n") ? -1 : at;
  }
  return -1;
}

/**
 * The opening, then the paragraphs that best match the query, then the rest in order while it fits; shown in
 * document order with a gap mark where text was left out. end: where the shown opening run stops (to read on from).
 */
export function pickDocumentParts(body: string, query: string | undefined, budget = TEXT_CHARS):
  { readonly text: string; readonly complete: boolean; readonly end: number } {
  if (body.length <= budget) return { text: indent(body), complete: true, end: body.length };
  const all = paragraphs(body);
  const terms = query ? queryTerms(query) : [];
  const chosen = new Set<number>();
  let used = 0;
  const take = (index: number): boolean => {
    if (chosen.has(index)) return true;
    const length = all[index]!.text.length + BODY_INDENT.length + GAP.length + 2;
    if (used + length > budget) return false;
    chosen.add(index);
    used += length;
    return true;
  };
  for (let index = 0; index < all.length && all[index]!.start < OPENING_CHARS; index += 1) {
    if (!take(index)) break;
  }
  const ranked = all.map((part, index) => ({ index, value: score(part, terms) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index);
  for (const { index } of ranked) {
    const heading = headingAbove(all, index);
    if (take(index) && heading >= 0) take(heading);
  }
  for (let index = 0; index < all.length; index += 1) {
    if (!take(index)) break;
  }
  if (chosen.size === 0) {
    const text = cutTo(body, budget);
    return { text: indent(text), complete: false, end: Math.max(text.length - 3, 0) };
  }
  let end = 0;
  for (let index = 0; chosen.has(index); index += 1) end = all[index]!.start + all[index]!.text.length;
  const lines: string[] = [];
  let previous = -1;
  for (const index of [...chosen].sort((a, b) => a - b)) {
    if (index !== previous + 1) lines.push(GAP);
    lines.push(indent(all[index]!.text));
    previous = index;
  }
  if (previous < all.length - 1) lines.push(GAP);
  return { text: lines.join("\n"), complete: false, end };
}

/** A slice that never ends inside a surrogate pair. */
function sliceText(text: string, start: number, length: number): string {
  const window = text.slice(start, start + length);
  return /[\uD800-\uDBFF]$/.test(window) ? window.slice(0, -1) : window;
}

export function renderBrainDocument(view: BrainDocumentView, input: { readonly query?: string; readonly offset?: number }):
  BrainReadAnswer {
  const body = clean(view.body);
  const id = oneLine(view.cite.documentId, 80);
  const head = [citeText(view.cite), ...permalinkLines(view.cite, ""), `Document id: ${id} (${body.length} characters)`];
  if (input.offset !== undefined) {
    if (input.offset >= body.length) {
      return { text: [...head, `The document ends before character ${input.offset}.`].join("\n"), external: true };
    }
    const window = sliceText(body, input.offset, TEXT_CHARS);
    const end = input.offset + window.length;
    const footer = end < body.length
      ? `More: call brain_document with offset ${end}.` : "End of the document.";
    return {
      text: [...head, `Text from character ${input.offset}:`, indent(window), footer].join("\n"),
      external: true,
    };
  }
  const picked = pickDocumentParts(body, input.query);
  const what = picked.complete ? "Whole text:"
    : input.query ? `The opening and the parts that best match "${oneLine(input.query, 200)}" ([...] marks text left out):`
    : "The opening ([...] marks text left out):";
  const footer = picked.complete ? [] : [
    `Parts were left out for length. Call brain_document with other query words, or with offset ${picked.end} ` +
      "to read on in order.",
  ];
  return { text: [...head, what, picked.text, ...footer].join("\n"), external: true };
}

export const BRAIN_DOCUMENT_MESSAGES = {
  notFound: "That document was not found in this project. Use a Document id printed by brain_search or brain_claims.",
  invalid: "That document id, query or offset is not valid.",
} as const;
