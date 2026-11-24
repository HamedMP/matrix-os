/**
 * Defined terms and cross-references as editor highlights. Every use of a
 * defined term (whole word, same case) outside its definition gets a
 * `terms` highlight; every cross-reference the engine found gets an `xrefs`
 * highlight. Each highlight has its own id (`term:<term>.<use>`, `xref:<n>`);
 * `referenceInfo` finds what the hover card shows for it.
 */

import type { BlockId, DocxDocument, TextRange } from "../../../_shared/office-engine/index";
import type { EditorHighlight } from "../editor/index";
import { findMatches } from "./find-model";
import { type ParagraphText, visibleParagraphs } from "./text-index";

export const TERMS_LAYER = "terms";
export const XREFS_LAYER = "xrefs";
/** Most terms looked up and most highlights per layer. */
export const MAX_TERMS = 200;
export const MAX_REFERENCE_HIGHLIGHTS = 3_000;
const MAX_DEFINITION = 600;

export type ReferenceInfo =
  | { kind: "term"; term: string; definition: string; target: TextRange }
  | { kind: "xref"; text: string; label: string | null; preview: string | null; targetBlockId: BlockId | null; broken: boolean };

export interface ReferenceIndex {
  terms: EditorHighlight[];
  xrefs: EditorHighlight[];
  /** By term (`term:<n>`) and cross-reference (`xref:<n>`). */
  info: Map<string, ReferenceInfo>;
  /** The range of each highlight, by highlight id. */
  ranges: Map<string, TextRange>;
}

function overlaps(a: TextRange, b: TextRange): boolean {
  return a.start.blockId === b.start.blockId && a.start.offset < b.end.offset && b.start.offset < a.end.offset;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DEFINITION ? `${flat.slice(0, MAX_DEFINITION - 1)}…` : flat;
}

export function buildReferenceIndex(doc: DocxDocument, paragraphs: readonly ParagraphText[] = visibleParagraphs(doc, "final")): ReferenceIndex {
  const info = new Map<string, ReferenceInfo>();
  const ranges = new Map<string, TextRange>();
  const terms: EditorHighlight[] = [];
  doc
    .getDefinedTerms()
    .slice(0, MAX_TERMS)
    .forEach((defined, index) => {
      if (defined.term.trim().length < 2) return;
      const id = `term:${index}`;
      info.set(id, { kind: "term", term: defined.term, definition: clip(defined.definition), target: defined.range });
      const room = MAX_REFERENCE_HIGHLIGHTS - terms.length;
      if (room <= 0) return;
      for (const match of findMatches(paragraphs, defined.term, { matchCase: true, wholeWord: true }, room + 1).matches) {
        if (overlaps(match.range, defined.range)) continue;
        if (terms.length === MAX_REFERENCE_HIGHLIGHTS) break;
        const useId = `${id}.${terms.length}`;
        ranges.set(useId, match.range);
        terms.push({ id: useId, range: match.range });
      }
    });
  const xrefs: EditorHighlight[] = [];
  doc
    .getCrossReferences()
    .slice(0, MAX_REFERENCE_HIGHLIGHTS)
    .forEach((reference, index) => {
      const id = `xref:${index}`;
      info.set(id, {
        kind: "xref",
        text: reference.text,
        label: reference.targetLabel,
        preview: reference.targetText === null ? null : clip(reference.targetText),
        targetBlockId: reference.targetBlockId,
        broken: reference.broken,
      });
      ranges.set(id, reference.range);
      xrefs.push({ id, range: reference.range, className: reference.broken ? "is-broken" : undefined });
    });
  return { terms, xrefs, info, ranges };
}

/** What the hover card shows for a highlight id. */
export function referenceInfo(index: ReferenceIndex, highlightId: string): ReferenceInfo | null {
  return index.info.get(highlightId.split(".")[0] ?? "") ?? null;
}

/** The term and cross-reference ids on a highlighted span (`data-hl-id`). */
export function referenceIdsAt(element: Element): string[] {
  const ids = element.getAttribute("data-hl-id");
  if (ids === null) return [];
  return ids.split(/\s+/).filter((id) => id.startsWith("term:") || id.startsWith("xref:"));
}
