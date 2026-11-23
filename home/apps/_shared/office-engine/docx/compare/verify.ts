/**
 * The self-check of a comparison: with every revision accepted the result
 * must read like the revised document, and with every revision rejected like
 * the original. A result that fails is never returned.
 *
 * Text is read like `DocxDocument.getPlainText` reads it, with one
 * difference: a paragraph that is wholly gone in a view (no text and no
 * mark) leaves nothing behind even when no paragraph follows it to take its
 * place, which is what accepting or rejecting the revision does to it.
 */

import type { DocxTextView, StoryId } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import {
  type BlockRecord,
  type DocxIndex,
  type ParagraphScan,
  atomInView,
  attr,
  paragraphText,
  rowCells,
  rowRevisionElement,
  tableRows,
} from "../internal.js";
import { COMPARE_SELF_CHECK, type CompareExpectation } from "./types.js";

type NoteKind = "footnote" | "endnote";

function goneInView(revisionName: string | undefined, view: DocxTextView): boolean {
  if (revisionName === undefined || view === "markup") return false;
  const removal = revisionName === "w:del" || revisionName === "w:moveFrom";
  return view === "final" ? removal : !removal;
}

/** Calls `visit` for every paragraph that has a part in the view, in document order. */
function eachParagraph(index: DocxIndex, records: readonly BlockRecord[], view: DocxTextView, visit: (scan: ParagraphScan) => void): void {
  for (const record of records) {
    if (record.type === "paragraph") {
      visit(index.scan(record.element));
    } else if (record.type === "table") {
      for (const row of tableRows(record.element)) {
        if (goneInView(rowRevisionElement(row)?.name, view)) continue;
        for (const cell of rowCells(row)) eachParagraph(index, index.blocksIn(cell), view, visit);
      }
    }
  }
}

/** Plain text of sibling blocks in a view; see the file comment. */
export function textInView(index: DocxIndex, records: readonly BlockRecord[], view: DocxTextView): string {
  let text = "";
  // Where the current line starts: text behind it waits for a paragraph mark.
  let lineStart = 0;
  for (let position = 0; position < records.length; position++) {
    const record = records[position] as BlockRecord;
    if (record.type === "table") {
      for (const row of tableRows(record.element)) {
        if (goneInView(rowRevisionElement(row)?.name, view)) continue;
        const cells = rowCells(row).map((cell) => textInView(index, index.blocksIn(cell), view).replace(/\n$/, ""));
        text += `${cells.join("\t")}\n`;
      }
      lineStart = text.length;
    } else if (record.type === "paragraph") {
      const scan = index.scan(record.element);
      text += paragraphText(scan, view);
      const next = records[position + 1];
      const joins = goneInView(scan.mark?.name, view) && next !== undefined && next.type === "paragraph";
      if (joins) continue;
      // A mark that is gone with nothing after it to join ends the line only when the line has text.
      if (!goneInView(scan.mark?.name, view) || text.length > lineStart) text += "\n";
      lineStart = text.length;
    }
  }
  return text;
}

/** Text of a story in a view, or null when the document has no such story. */
export function storyTextInView(index: DocxIndex, storyId: StoryId, view: DocxTextView): string | null {
  const story = index.story(storyId);
  return story === null ? null : textInView(index, story.blocks, view);
}

/** Ids of the notes the body refers to in a view, each once, in the order of their first reference. */
export function noteIdsInView(index: DocxIndex, kind: NoteKind, view: DocxTextView): string[] {
  const body = index.story("body");
  const ids: string[] = [];
  if (body === null) return ids;
  const seen = new Set<string>();
  const name = `w:${kind}Reference`;
  eachParagraph(index, body.blocks, view, (scan) => {
    for (const atom of scan.atoms) {
      if (atom.kind !== "object" || atom.node.name !== name || !atomInView(atom, view)) continue;
      const id = attr(atom.node as XmlElement, "w:id");
      if (id === null || seen.has(id) || index.story(`${kind}:${id}`) === null) continue;
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}

/** Texts of the notes the body refers to in a view, in the order of their references. */
export function noteTextsInView(index: DocxIndex, kind: NoteKind, view: DocxTextView): string[] {
  return noteIdsInView(index, kind, view).map((id) => storyTextInView(index, `${kind}:${id}`, view) ?? "");
}

function firstDifference(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  for (let offset = 0; offset < limit; offset++) if (a.charCodeAt(offset) !== b.charCodeAt(offset)) return offset;
  return limit;
}

function fail(story: string, view: "final" | "original", actual: string, expected: string): never {
  throw new OfficeError("invalid_operation", "the comparison result does not reproduce its inputs", {
    details: {
      check: COMPARE_SELF_CHECK,
      story,
      view,
      offset: firstDifference(actual, expected),
      actualLength: actual.length,
      expectedLength: expected.length,
    },
  });
}

function compareLists(label: string, view: "final" | "original", actual: readonly string[], expected: readonly string[]): void {
  const count = Math.max(actual.length, expected.length);
  for (let position = 0; position < count; position++) {
    const mine = actual[position];
    const theirs = expected[position];
    if (mine !== theirs) fail(`${label} ${position + 1}`, view, mine ?? "", theirs ?? "");
  }
}

/**
 * Checks a comparison result against the texts of its inputs. Throws
 * `OfficeError("invalid_operation")` with `details.check` set to
 * `COMPARE_SELF_CHECK`, the story, the view (`final` or `original`) and the
 * offset of the first difference.
 */
export function verifyComparison(index: DocxIndex, expected: CompareExpectation): void {
  const stories: Array<{ storyId: StoryId; label: string; original: string; revised: string }> = [
    { storyId: "body", ...expected.body },
    ...expected.stories,
  ];
  for (const story of stories) {
    for (const view of ["final", "original"] as const) {
      const actual = storyTextInView(index, story.storyId, view);
      const wanted = view === "final" ? story.revised : story.original;
      if (actual !== wanted) fail(story.label, view, actual ?? "", wanted);
    }
  }
  for (const kind of ["footnote", "endnote"] as const) {
    compareLists(kind, "final", noteTextsInView(index, kind, "final"), expected.notes[kind].revised);
    compareLists(kind, "original", noteTextsInView(index, kind, "original"), expected.notes[kind].original);
  }
}
