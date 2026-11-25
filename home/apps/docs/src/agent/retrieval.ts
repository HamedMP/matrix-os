/**
 * Retrieval for long documents: which paragraphs an instruction is about.
 *
 * Deterministic and local. Paragraphs score by the instruction words they
 * contain (rarer words weigh more), clause numbers the instruction names
 * ("clause 5.2", "section 4") pull in that clause, and defined terms the
 * instruction names pull in their definition.
 */

import type { DescribedBlock, DocumentText } from "./description";
import { clauseOf } from "./description";
import type { BlockId } from "./engine";

const STOPWORDS = new Set(
  (
    "the and for with that this these those from into onto over under than then there their they them what when where which " +
    "while who whom whose why how all any each every some such only own same other about above after again against below " +
    "between both down during further here more most once very can will just should would could shall must may might " +
    "make made makes please document draft text paragraph paragraphs clause clauses section sections agreement change " +
    "changes edit edits rewrite replace update add remove delete tighten proofread summarise summarize review"
  ).split(" "),
);

/** Share of the best score a paragraph needs to count as relevant. */
const MIN_RELATIVE_SCORE = 0.25;

const REFERENCE = /\b(?:clause|section|paragraph|schedule|article|part)s?\s+(\d{1,3}(?:\.\d{1,3}){0,3})/gi;
const LABEL_AT_START = /^\[[^\]]+\](?: \([^)]*\))? (\d{1,3}(?:\.\d{1,3}){0,3})\.?(?:\s|$)/;

/** Lower-case words of at least three letters, without stop words. */
export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu) ?? [];
  const unique = new Set<string>();
  for (const word of words) {
    const clean = word.replace(/['’]s$/, "");
    if (!STOPWORDS.has(clean)) unique.add(clean);
    if (unique.size >= 64) break;
  }
  return [...unique];
}

/** Clause numbers named in the instruction, for example `5.2` for "clause 5.2". */
export function namedClauses(instruction: string): string[] {
  const found = new Set<string>();
  for (const match of instruction.matchAll(REFERENCE)) {
    found.add(match[1] as string);
    if (found.size >= 32) break;
  }
  return [...found];
}

/** The typed number at the start of a description line, without its trailing dot. */
function lineLabel(line: string): string | null {
  return LABEL_AT_START.exec(line)?.[1] ?? null;
}

export interface RetrievalOptions {
  /** Defined terms of the document (`term`, defining block). */
  definedTerms?: ReadonlyArray<{ term: string; blockId: BlockId }>;
}

/**
 * Paragraphs ranked by relevance to the instruction, most relevant first.
 * Paragraphs with no relevance are left out.
 */
export function rankBlocks(text: DocumentText, instruction: string, options: RetrievalOptions = {}): DescribedBlock[] {
  const scores = new Map<BlockId, number>();
  const bump = (id: BlockId, amount: number) => scores.set(id, (scores.get(id) ?? 0) + amount);

  const words = keywords(instruction);
  if (words.length > 0) {
    const lowered = text.blocks.map((block) => block.line.toLowerCase());
    const total = text.blocks.length;
    for (const word of words) {
      let frequency = 0;
      for (const line of lowered) if (line.includes(word)) frequency++;
      if (frequency === 0) continue;
      const weight = Math.log((total + 1) / frequency) + 1;
      lowered.forEach((line, index) => {
        if (line.includes(word)) bump((text.blocks[index] as DescribedBlock).id, weight);
      });
    }
  }

  const named = namedClauses(instruction);
  if (named.length > 0) {
    for (const block of text.blocks) {
      const label = lineLabel(block.line);
      if (label === null) continue;
      for (const number of named) {
        if (label === number) {
          // A heading brings its whole clause; a numbered paragraph brings itself and its heading.
          const members = block.headingLevel > 0 ? clauseOf(text, block) : [block];
          for (const member of members) bump(member.id, 50);
          if (block.headingLevel === 0 && block.clause >= 0) bump((text.blocks[block.clause] as DescribedBlock).id, 10);
        } else if (label.startsWith(`${number}.`)) {
          bump(block.id, 40);
        }
      }
    }
  }

  const lower = instruction.toLowerCase();
  for (const term of options.definedTerms ?? []) {
    if (term.term.length < 2 || !lower.includes(term.term.toLowerCase())) continue;
    if (text.byId.has(term.blockId)) bump(term.blockId, 20);
  }

  // Paragraphs that only share common words with the instruction are noise next to the best matches.
  const top = Math.max(0, ...scores.values());
  return [...scores.entries()]
    .filter(([, score]) => score > 0 && score >= top * MIN_RELATIVE_SCORE)
    .sort((a, b) => b[1] - a[1] || (text.byId.get(a[0])?.order ?? 0) - (text.byId.get(b[0])?.order ?? 0))
    .map(([id]) => text.byId.get(id) as DescribedBlock);
}

/** True when the instruction points at particular clauses rather than at the whole document. */
export function isTargeted(text: DocumentText, instruction: string, options: RetrievalOptions = {}): boolean {
  if (namedClauses(instruction).length > 0) return true;
  const ranked = rankBlocks(text, instruction, options);
  // A few strongly matching paragraphs, not a word that is everywhere.
  return ranked.length > 0 && ranked.length <= Math.max(3, Math.floor(text.blocks.length * 0.25));
}
