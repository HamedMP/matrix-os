/**
 * Defined terms: quoted or bold text followed by a defining phrase
 * (`“Services” means …`), and terms defined in passing (`(the “Customer”)`).
 */

import type { DefinedTerm } from "../../api/docx-model.js";
import type { DocxIndex } from "./doc-index.js";
import { OBJECT_CHAR, type ParagraphScan, atomInView, scanText } from "./inline.js";
import { viewToMarkupOffset } from "./positions.js";
import { firstChild } from "./names.js";
import { tableStyleIdOf } from "./resolve.js";
import type { BlockRecord } from "./structure.js";

const DEFINING =
  "(?:shall\\s+(?:each\\s+)?(?:mean|have\\s+the\\s+meanings?|include|be\\s+construed)|means?|has\\s+the\\s+meanings?|have\\s+the\\s+meanings?|includes?|refers\\s+to|is\\s+defined\\s+as|are\\s+defined\\s+as)\\b";
/** Double quotation marks, curly or straight, or curly single ones; an apostrophe inside double quotes is kept. */
const QUOTED = /[\u201C"]([^\u201C\u201D"\n]{1,80})[\u201D"]|\u2018([^\u2018\u2019\n]{1,80})\u2019(?![A-Za-z])/g;
const AFTER_TERM = new RegExp(`^[\\s,:\\u2013\\u2014-]*${DEFINING}`, "i");
/** `(the “Customer”)`, `(together with its affiliates, the “Group”)`, `(“Seller” or “Vendor”)`. */
const BEFORE_PARENTHETICAL = /\((?:[^()\n]{0,80}[\s,])?(?:the|an?|as|or|and|each|together)\s+$|\(\s*$/i;
const AFTER_PARENTHETICAL = /^(?:\s*(?:,|or|and|\/)\s*[\u201C"][^\u201C\u201D"\n]{1,80}[\u201D"])*\s*\)/;

/** Longest paragraph searched for definitions, and the most quoted stretches looked at in one paragraph. */
const MAX_PARAGRAPH = 20_000;
const MAX_QUOTED = 200;
/** How far back from a quoted term the opening parenthesis of a definition in passing is looked for. */
const PARENTHETICAL_WINDOW = 120;

interface Found {
  /** Offsets of the term (without quotation marks) in the `final` text. */
  readonly start: number;
  readonly end: number;
  readonly term: string;
  readonly definition: string;
  readonly marker: "quoted" | "bold";
  /** Where the next definition of the same paragraph may cut this one's text. */
  readonly definitionStart: number;
}

/** Stretches of the `final` text that are bold, as [start, end) offsets in that text. */
function boldStretches(index: DocxIndex, record: BlockRecord, scan: ParagraphScan): Array<[number, number]> {
  const table = record.parentTableId === null ? null : index.block(record.parentTableId);
  const base = index.resolver.paragraph(record.element, tableStyleIdOf(table?.element ?? null)).runBase;
  const stretches: Array<[number, number]> = [];
  let offset = 0;
  for (const atom of scan.atoms) {
    if (!atomInView(atom, "final")) continue;
    const bold =
      atom.run !== null && atom.kind !== "object" && index.resolver.runFormat(base, firstChild(atom.run, "w:rPr")).bold;
    const end = offset + atom.text.length;
    const last = stretches[stretches.length - 1];
    if (bold) {
      if (last !== undefined && last[1] === offset) last[1] = end;
      else stretches.push([offset, end]);
    }
    offset = end;
  }
  return stretches;
}

function sentenceBefore(text: string, end: number): string {
  const head = text.slice(0, end);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\t"), head.lastIndexOf("; "), head.lastIndexOf("\t"));
  return head.slice(stop === -1 ? 0 : stop + 1).replace(/^[\s.;]+/, "").trim();
}

function findInParagraph(index: DocxIndex, record: BlockRecord, scan: ParagraphScan): Found[] {
  const text = scanText(scan, "final");
  if (text.length === 0 || text.length > MAX_PARAGRAPH) return [];
  const found: Found[] = [];
  QUOTED.lastIndex = 0;
  let quoted = 0;
  for (let match = QUOTED.exec(text); match !== null && quoted < MAX_QUOTED; match = QUOTED.exec(text)) {
    quoted += 1;
    const inner = match[1] ?? match[2] ?? "";
    const term = inner.trim();
    if (term === "" || term.includes(OBJECT_CHAR)) continue;
    const start = match.index + 1 + inner.indexOf(term);
    const after = text.slice(match.index + match[0].length);
    if (AFTER_TERM.test(after)) {
      found.push({
        start,
        end: start + term.length,
        term,
        definition: after,
        marker: "quoted",
        definitionStart: match.index,
      });
    } else if (
      AFTER_PARENTHETICAL.test(after) &&
      BEFORE_PARENTHETICAL.test(text.slice(Math.max(0, match.index - PARENTHETICAL_WINDOW), match.index))
    ) {
      const open = text.lastIndexOf("(", match.index);
      found.push({
        start,
        end: start + term.length,
        term,
        definition: sentenceBefore(text, open),
        marker: "quoted",
        definitionStart: Number.POSITIVE_INFINITY,
      });
    }
  }
  for (const [start, end] of boldStretches(index, record, scan)) {
    const raw = text.slice(start, end);
    const term = raw.trim();
    if (term === "" || term.length > 80 || /[“”"￼\n]/.test(term)) continue;
    if (!AFTER_TERM.test(text.slice(end))) continue;
    const termStart = start + raw.indexOf(term);
    if (found.some((entry) => entry.start < end && termStart < entry.end)) continue;
    found.push({
      start: termStart,
      end: termStart + term.length,
      term,
      definition: text.slice(end),
      marker: "bold",
      definitionStart: start,
    });
  }
  found.sort((a, b) => a.start - b.start);
  return found.map((entry, position) => {
    if (entry.definitionStart === Number.POSITIVE_INFINITY) return entry;
    // A paragraph with several definitions: each ends where the next begins.
    const next = found.slice(position + 1).find((other) => other.definitionStart !== Number.POSITIVE_INFINITY);
    const cut = next === undefined ? text.length : next.definitionStart;
    const from = entry.marker === "quoted" ? entry.end + 1 : entry.end;
    return { ...entry, definition: text.slice(from, Math.max(from, cut)) };
  });
}

/** Defined terms of the body in document order. */
export function findDefinedTerms(index: DocxIndex): DefinedTerm[] {
  const terms: DefinedTerm[] = [];
  const body = index.structure.stories[0];
  if (body === undefined) return terms;
  for (const paragraph of body.paragraphs) {
    const record = index.blockOf(paragraph);
    if (record === null) continue;
    const scan = index.scan(paragraph);
    for (const entry of findInParagraph(index, record, scan)) {
      terms.push({
        term: entry.term,
        definition: entry.definition.split(OBJECT_CHAR).join("").trim(),
        blockId: record.id,
        range: {
          start: { blockId: record.id, offset: viewToMarkupOffset(scan, "final", entry.start, "after") },
          end: { blockId: record.id, offset: viewToMarkupOffset(scan, "final", entry.end, "before") },
        },
        marker: entry.marker,
      });
    }
  }
  return terms;
}
