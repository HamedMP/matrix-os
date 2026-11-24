import type { ApplyOptions, DocxDocument, DocxOp, TextPosition } from "../../../../packages/office/src/api/docx.js";
import { markRevisions } from "../../../../packages/office/src/docx/edit/marks.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";
import { p, r } from "../model/build.js";
import { build } from "./helpers.js";

/**
 * Randomised edit sequences against a reference model of the visible text.
 * The reference is a list of paragraph strings: what the document must read
 * once every tracked change is accepted. Rejecting everything must give back
 * the text the document started with.
 *
 * Shared by the test and by the script that writes sample files for the
 * independent validators.
 */

/** Names of the tracked-change elements on the mark of a paragraph. */
function markRevisionsForTest(doc: DocxDocument, blockId: string): string[] {
  const record = getDocxIndex(doc).block(blockId);
  return record === null ? [] : markRevisions(record.element).map((element) => element.name);
}

const WORDS = ["alpha", "beta", "gamma", "delta", "payment", "notice", "term", "the", "of", "30 days", "shall", "\t", "x"];

function sourceBody(): string {
  return [
    p(r("The Supplier shall deliver the Services ") + r("on time", "<w:b/>") + r(" and in full.")),
    p(r("Payment is due within 30 days of the invoice date."), '<w:pStyle w:val="Clause"/>'),
    p(
      r("See ") +
        '<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the terms</w:t></w:r></w:hyperlink>' +
        r(" for details.") +
        "<w:r><w:tab/><w:t>End</w:t></w:r>",
    ),
    p(
      r("Dated ") +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>23 November 2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        r(" in London."),
    ),
    p(r("Either party may terminate on 90 days notice.")),
    p(r("Signed by the parties.")),
  ].join("");
}

export function newDocument(): DocxDocument {
  return build({
    body: sourceBody(),
    styles:
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Clause"><w:name w:val="Clause"/><w:basedOn w:val="Normal"/></w:style>' +
      '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>',
    links: { rIdLink: "https://example.com/terms" },
  });
}

interface Segment {
  blockId: string;
  /** Offset of the block's visible text inside its visible paragraph. */
  start: number;
  length: number;
}

/** The visible paragraphs of the body, each with the blocks that make it up. */
function visibleParagraphs(doc: DocxDocument): Segment[][] {
  const groups: Segment[][] = [];
  let current: Segment[] = [];
  let offset = 0;
  const blocks = doc.getView().body.blocks;
  blocks.forEach((block, at) => {
    if (block.type !== "paragraph") return;
    const visible = doc.getPlainText({
      range: { start: { blockId: block.id, offset: 0 }, end: { blockId: block.id, offset: block.text.length } },
    });
    current.push({ blockId: block.id, start: offset, length: visible.length });
    offset += visible.length;
    const next = blocks[at + 1];
    const joins = markRevisionsForTest(doc, block.id).some((name) => name === "w:del") && next !== undefined && next.type === "paragraph";
    if (!joins) {
      groups.push(current);
      current = [];
      offset = 0;
    }
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

function locate(doc: DocxDocument, group: Segment[], offset: number, last: boolean): TextPosition {
  const ordered = last ? [...group].reverse() : group;
  const segment = ordered.find((entry) => offset >= entry.start && offset <= entry.start + entry.length) ?? (group[group.length - 1] as Segment);
  return finalToMarkup(doc, segment.blockId, offset - segment.start, last ? "before" : "after");
}

function finalToMarkup(doc: DocxDocument, blockId: string, offset: number, bias: "before" | "after"): TextPosition {
  const index = getDocxIndex(doc);
  const scan = index.scan(blockId);
  // Count visible characters by hand, so the test does not lean on the helper under test.
  let seen = 0;
  let low = -1;
  let high = scan.text.length;
  for (const atom of scan.atoms) {
    if (atom.context.deleted) continue;
    if (low === -1 && offset <= seen + atom.text.length) low = atom.start + (offset - seen);
    if (offset < seen + atom.text.length) {
      high = atom.start + Math.max(0, offset - seen);
      break;
    }
    seen += atom.text.length;
  }
  if (low === -1) low = scan.text.length;
  return { blockId, offset: bias === "before" ? low : high };
}

export function expected(reference: string[]): string {
  return reference.map((line) => `${line}\n`).join("");
}

function pickText(random: () => number): string {
  const count = 1 + Math.floor(random() * 3);
  const parts: string[] = [];
  for (let at = 0; at < count; at++) parts.push(WORDS[Math.floor(random() * WORDS.length)] as string);
  return parts.join(" ");
}

/** Applies one random operation to the document and to the reference. Returns the operation for the failure message. */
export function step(doc: DocxDocument, reference: string[], random: () => number, options: ApplyOptions): DocxOp | null {
  const groups = visibleParagraphs(doc);
  if (groups.length !== reference.length) {
    throw new Error(`the document shows ${groups.length} paragraphs, the reference has ${reference.length}`);
  }
  const at = Math.floor(random() * groups.length);
  const group = groups[at] as Segment[];
  const line = reference[at] as string;
  const a = Math.floor(random() * (line.length + 1));
  const b = Math.min(line.length, a + Math.floor(random() * 12));
  const choice = random();
  let op: DocxOp;
  if (choice < 0.24) {
    const value = pickText(random);
    op = { type: "insertText", at: locate(doc, group, a, random() < 0.5), text: value };
    reference[at] = line.slice(0, a) + value + line.slice(a);
  } else if (choice < 0.42) {
    op = { type: "deleteRange", range: { start: locate(doc, group, a, false), end: locate(doc, group, b, true) } };
    if (op.range.start.blockId === op.range.end.blockId && op.range.start.offset > op.range.end.offset) return null;
    reference[at] = line.slice(0, a) + line.slice(b);
  } else if (choice < 0.56) {
    const value = pickText(random);
    const words = random() < 0.5;
    const start = locate(doc, group, a, false);
    const end = locate(doc, group, b, true);
    if (start.blockId === end.blockId && start.offset > end.offset) return null;
    if (words && start.blockId !== end.blockId) return null;
    op = { type: "replaceRange", range: { start, end }, text: value, granularity: words ? "words" : "whole" };
    reference[at] = line.slice(0, a) + value + line.slice(b);
  } else if (choice < 0.66 && at + 1 < groups.length) {
    // A deletion across paragraph marks.
    const reach = Math.min(groups.length - 1, at + 1 + Math.floor(random() * 2));
    const target = reference[reach] as string;
    const c = Math.floor(random() * (target.length + 1));
    op = {
      type: "deleteRange",
      range: { start: locate(doc, group, a, false), end: locate(doc, groups[reach] as Segment[], c, true) },
    };
    reference.splice(at, reach - at + 1, line.slice(0, a) + target.slice(c));
  } else if (choice < 0.74) {
    op = { type: "splitParagraph", at: locate(doc, group, a, random() < 0.5) };
    reference.splice(at, 1, line.slice(0, a), line.slice(a));
  } else if (choice < 0.82) {
    const value = random() < 0.3 ? "" : pickText(random);
    const after = random() < 0.5;
    const blockId = (after ? (group[group.length - 1] as Segment) : (group[0] as Segment)).blockId;
    op = { type: after ? "insertParagraphAfter" : "insertParagraphBefore", blockId, text: value };
    reference.splice(after ? at + 1 : at, 0, value);
  } else if (choice < 0.9) {
    if (group.length !== 1) return null;
    op = { type: "deleteParagraph", blockId: (group[0] as Segment).blockId };
    if (at === groups.length - 1) reference[at] = "";
    else reference.splice(at, 1);
  } else if (choice < 0.95) {
    const start = locate(doc, group, a, false);
    const end = locate(doc, group, b, true);
    if (start.blockId === end.blockId && start.offset > end.offset) return null;
    op = { type: "setRunFormat", range: { start, end }, format: { bold: random() < 0.5, italic: true } };
  } else {
    op = {
      type: "setParagraphStyle",
      blockId: (group[0] as Segment).blockId,
      style: { alignment: random() < 0.5 ? "center" : "right", spacingAfterPt: 6 },
    };
  }
  doc.applyOps([op], options);
  return op;
}
