/**
 * Cross-references of the body: `REF`, `PAGEREF` and `NOTEREF` fields, links
 * to bookmarks, table-of-contents entries, and references an author typed
 * (`clause 8.2`, `Section 3(a)`, `Schedule 1`) resolved against the clause
 * labels of the document.
 */

import type { CrossReference, FieldInfo } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { DocxIndex } from "./doc-index.js";
import { parseFieldInstruction } from "./fields.js";
import { type FieldFrame, type ParagraphScan, atomInView, scanText } from "./inline.js";
import { attr } from "./names.js";
import { type LabelIndex, buildLabelIndex, buildOutline } from "./labels.js";
import { paragraphText } from "./plain-text.js";
import { viewToMarkupOffset } from "./positions.js";
import { fieldInfoOf } from "./view.js";
import type { BlockRecord } from "./structure.js";

const PREVIEW_LENGTH = 240;
const MAX_PARAGRAPH = 20_000;

const NUMBER = "\\d{1,3}(?:\\.\\d{1,3})*(?:\\([a-zA-Z0-9]{1,4}\\))*";
const CLAUSE_WORDS = "sub-?clauses?|clauses?|sections?|articles?|paragraphs?";
const PART_WORDS = "schedules?|appendix|appendices|annexures?|annexes|annex|exhibits?";
const TYPED = new RegExp(
  `\\b(?:(${CLAUSE_WORDS})[ \\u00A0]+(${NUMBER})|(${PART_WORDS})[ \\u00A0]+(\\d{1,3}|[A-Z]\\b))`,
  "gi",
);
const LIST_ITEM = new RegExp(`^(\\s*(?:,|and|or|to|&)\\s*|\\s*,\\s*(?:and|or)\\s+)(${NUMBER})(?![\\w%])`, "i");

/** Bounds for a list such as `clauses 6, 7, 8 and 12`: its length and how far ahead one item is looked for. */
const MAX_LIST_ITEMS = 50;
const LIST_ITEM_WINDOW = 48;

interface Draft {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly source: "field" | "text";
  readonly target: BlockRecord | null;
}

function singular(word: string): string {
  const lower = word.toLowerCase();
  if (lower === "appendices") return "appendix";
  if (lower === "annexes") return "annex";
  return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

function typedReferences(scan: ParagraphScan, record: BlockRecord, labels: LabelIndex): Draft[] {
  const text = scanText(scan, "final");
  if (text.length === 0 || text.length > MAX_PARAGRAPH) return [];
  const drafts: Draft[] = [];
  const add = (start: number, end: number, key: string): void => {
    const target = labels.byKey.get(key.toLowerCase()) ?? null;
    // A heading such as `Schedule 1` names itself; that is not a reference.
    if (target === record && start === 0) return;
    drafts.push({ start, end, text: text.slice(start, end), source: "text", target });
  };
  TYPED.lastIndex = 0;
  for (let match = TYPED.exec(text); match !== null; match = TYPED.exec(text)) {
    const [whole, clauseWord, clauseNumber, partWord, partNumber] = match;
    if (partWord !== undefined && partNumber !== undefined) {
      // `Schedule A` is a reference; `schedule a meeting` is not.
      const lettered = /^[A-Za-z]$/.test(partNumber);
      if (lettered && !(/^[A-Z]$/.test(partNumber) && /^[A-Z]/.test(partWord))) continue;
      add(match.index, match.index + whole.length, `${singular(partWord)} ${partNumber}`);
      continue;
    }
    if (clauseWord === undefined || clauseNumber === undefined) continue;
    add(match.index, match.index + whole.length, clauseNumber);
    if (!clauseWord.toLowerCase().endsWith("s")) continue;
    // `clauses 6, 7, 8 and 12`: each further number is a reference of its own.
    let cursor = match.index + whole.length;
    for (let items = 0; items < MAX_LIST_ITEMS; items++) {
      const item = LIST_ITEM.exec(text.slice(cursor, cursor + LIST_ITEM_WINDOW));
      if (item === null) break;
      const start = cursor + (item[1] as string).length;
      const end = start + (item[2] as string).length;
      add(start, end, item[2] as string);
      cursor = end;
    }
    TYPED.lastIndex = cursor;
  }
  return drafts;
}

interface Stretch {
  start: number;
  end: number;
}

/** Start and end in the `final` text of the atoms each field and each link to a bookmark covers. */
function fieldReferences(index: DocxIndex, scan: ParagraphScan, headings: Map<string, BlockRecord>): Draft[] {
  const text = scanText(scan, "final");
  const fields = new Map<XmlElement, { frame: FieldFrame; stretch: Stretch }>();
  const links = new Map<XmlElement, Stretch>();
  const kindOf = new Map<XmlElement, string>();
  const kindsOf = (frames: readonly FieldFrame[]): string[] =>
    frames.map((frame) => {
      let kind = kindOf.get(frame.key);
      if (kind === undefined) {
        kind = parseFieldInstruction(frame.instruction).kind;
        kindOf.set(frame.key, kind);
      }
      return kind;
    });
  let offset = 0;
  let nestedInToc = false;
  let tocOnly = scan.atoms.length > 0;
  const extend = (stretch: Stretch | undefined, start: number, end: number): Stretch => {
    if (stretch === undefined) return { start, end };
    stretch.end = end;
    return stretch;
  };
  for (const atom of scan.atoms) {
    if (!atomInView(atom, "final")) continue;
    const end = offset + atom.text.length;
    const context = atom.context;
    for (const frame of context.fields) {
      const known = fields.get(frame.key);
      fields.set(frame.key, { frame, stretch: extend(known?.stretch, offset, end) });
    }
    if (context.hyperlink !== null && attr(context.hyperlink, "w:anchor") !== null) {
      links.set(context.hyperlink, extend(links.get(context.hyperlink), offset, end));
    }
    const kinds = kindsOf(context.fields);
    if (!kinds.includes("toc")) tocOnly = false;
    else if (kinds.some((kind) => kind !== "toc") || context.hyperlink !== null) nestedInToc = true;
    offset = end;
  }
  const drafts: Draft[] = [];
  const targetOf = (bookmark: string | null): BlockRecord | null => {
    const paragraph = bookmark === null ? null : (index.flow.bookmarks.get(bookmark) ?? null);
    return paragraph === null ? null : index.blockOf(paragraph);
  };
  for (const { frame, stretch } of fields.values()) {
    const info: FieldInfo = fieldInfoOf(index, frame);
    let bookmark = info.targetBookmark;
    if (info.kind === "hyperlink") bookmark = parseFieldInstruction(frame.instruction).switches.get("\\l") || null;
    else if (info.kind !== "ref" && info.kind !== "pageRef" && info.kind !== "noteRef") continue;
    if (bookmark === null) continue;
    drafts.push({
      start: stretch.start,
      end: stretch.end,
      text: text.slice(stretch.start, stretch.end),
      source: "field",
      target: targetOf(bookmark),
    });
  }
  for (const [element, stretch] of links) {
    drafts.push({
      start: stretch.start,
      end: stretch.end,
      text: text.slice(stretch.start, stretch.end),
      source: "field",
      target: targetOf(attr(element, "w:anchor")),
    });
  }
  if (tocOnly && !nestedInToc && text.trim() !== "") {
    // A cached table-of-contents entry without its own link: `2 Definitions<tab>4`.
    const entry = text.replace(/\t[^\t]*$/, "").trim();
    const target = headings.get(entry) ?? headings.get(entry.replace(/^\S+\s+/, "")) ?? null;
    drafts.push({ start: 0, end: text.length, text, source: "field", target });
  }
  return drafts;
}

/** Cross-references of the body in document order. */
export function findCrossReferences(index: DocxIndex): CrossReference[] {
  const references: CrossReference[] = [];
  const body = index.structure.stories[0];
  if (body === undefined) return references;
  const labels = buildLabelIndex(index);
  const headings = new Map<string, BlockRecord>();
  for (const item of buildOutline(index)) {
    const record = index.block(item.blockId);
    if (record === null) continue;
    const text = item.text.trim();
    for (const key of [text, item.numberingLabel === null ? text : `${item.numberingLabel.trim()} ${text}`]) {
      if (!headings.has(key)) headings.set(key, record);
    }
  }
  for (const paragraph of body.paragraphs) {
    const record = index.blockOf(paragraph);
    if (record === null) continue;
    const scan = index.scan(paragraph);
    if (scan.atoms.length === 0) continue;
    const fieldDrafts = fieldReferences(index, scan, headings);
    const typed = typedReferences(scan, record, labels).filter(
      // Text that a field already produced is the field's reference, not a typed one.
      (draft) => !fieldDrafts.some((field) => field.start < draft.end && draft.start < field.end),
    );
    const drafts = [...fieldDrafts, ...typed].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const draft of drafts) {
      const target = draft.target;
      const targetLabel = target === null ? null : (labels.byParagraph.get(target.element)?.text ?? null);
      references.push({
        blockId: record.id,
        range: {
          start: { blockId: record.id, offset: viewToMarkupOffset(scan, "final", draft.start, "after") },
          end: { blockId: record.id, offset: viewToMarkupOffset(scan, "final", draft.end, "before") },
        },
        text: draft.text,
        source: draft.source,
        targetBlockId: target?.id ?? null,
        targetLabel,
        targetText: target === null ? null : paragraphText(index.scan(target.element), "final").slice(0, PREVIEW_LENGTH),
        broken: target === null,
      });
    }
  }
  return references;
}
