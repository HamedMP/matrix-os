/**
 * Edit batches for the interoperability tests: every operation kind, and
 * the edits that cut through links, fields, notes, comment anchors,
 * bookmarks and merged cells. Each step picks its target from the document
 * as it is when the step runs, so a batch works on any fixture.
 */

import type {
  ApplyOptions,
  BlockId,
  DocxDocument,
  DocxOp,
  ParagraphBlock,
  TableBlock,
} from "../../../packages/office/src/index.js";

export const AGENT: ApplyOptions = { track: true, author: "Matrix Agent", date: "2026-11-23T10:00:00Z" };
export const OWNER: ApplyOptions = { track: true, author: "Rae Okafor", date: "2026-11-23T11:30:00Z" };
export const DIRECT: ApplyOptions = { track: false, author: "Rae Okafor", date: "2026-11-23T11:30:00Z" };

export const DOCX_FIXTURES = ["basic", "numbering", "table", "comments", "footnotes-headers", "tracked", "links-fields", "contract", "unicode"];

function bodyParagraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((b): b is ParagraphBlock => b.type === "paragraph");
}
function firstTable(doc: DocxDocument): TableBlock | null {
  return doc.getView().body.blocks.find((b): b is TableBlock => b.type === "table") ?? null;
}
/** A plain paragraph: long enough, no inline objects, no fields. */
function plain(p: ParagraphBlock, min: number): boolean {
  return p.text.length >= min && !p.text.includes("￼") && p.runs.every((r) => r.field === null);
}

type Step = [name: string, make: (doc: DocxDocument) => DocxOp[] | null];

/** Every operation kind, each aimed at a paragraph picked when the batch starts. */
export function editSteps(doc: DocxDocument): Step[] {
  const all = bodyParagraphs(doc);
  const long = all.filter((p) => plain(p, 24));
  const ids = (long.length >= 4 ? long : all.filter((p) => p.text.length >= 6)).map((p) => p.id);
  const n = ids.length;
  const pick = (k: number): BlockId | null => (n === 0 ? null : (ids[Math.floor((k * 7919) % n)] ?? null));
  const para = (d: DocxDocument, k: number): ParagraphBlock | null => {
    const id = pick(k);
    const b = id === null ? null : d.getBlock(id);
    return b !== null && b.type === "paragraph" ? b : null;
  };
  const steps: Step[] = [
    ["insertText", (d) => { const p = para(d, 0); return p && [{ type: "insertText", at: { blockId: p.id, offset: Math.min(5, p.text.length) }, text: "  [added & <ok> “q”]\ttab\nline  " }]; }],
    ["insertText.format", (d) => { const p = para(d, 1); return p && [{ type: "insertText", at: { blockId: p.id, offset: p.text.length }, text: " Formatted tail ", format: { bold: true, italic: true, underline: true, strike: true, color: "#c00000", highlight: "#ffff00", fontSizePt: 14, fontFamily: "Arial", verticalAlign: "superscript" } }]; }],
    ["insertText.start", (d) => { const p = para(d, 2); return p && [{ type: "insertText", at: { blockId: p.id, offset: 0 }, text: "Lead: " }]; }],
    ["deleteRange", (d) => { const p = para(d, 3); return p && [{ type: "deleteRange", range: { start: { blockId: p.id, offset: 2 }, end: { blockId: p.id, offset: Math.min(11, p.text.length) } } }]; }],
    ["replaceRange.whole", (d) => { const p = para(d, 4); return p && [{ type: "replaceRange", range: { start: { blockId: p.id, offset: 0 }, end: { blockId: p.id, offset: Math.min(8, p.text.length) } }, text: "Replaced text" }]; }],
    ["replaceRange.words", (d) => {
      const p = para(d, 5);
      if (!p) return null;
      const words = p.text.split(" ");
      const text = words.map((w, i) => (i % 4 === 1 ? `${w}X` : w)).join(" ");
      return [{ type: "replaceRange", range: { start: { blockId: p.id, offset: 0 }, end: { blockId: p.id, offset: p.text.length } }, text, granularity: "words" }];
    }],
    ["replaceRange.format", (d) => { const p = para(d, 6); return p && [{ type: "replaceRange", range: { start: { blockId: p.id, offset: 1 }, end: { blockId: p.id, offset: Math.min(4, p.text.length) } }, text: "BOLD", format: { bold: true } }]; }],
    ["insertParagraphAfter", (d) => { const p = para(d, 7); return p && [{ type: "insertParagraphAfter", blockId: p.id, text: "A new paragraph after, centred.", style: { alignment: "center" } }]; }],
    ["insertParagraphAfter.inherit", (d) => { const p = para(d, 8); return p && [{ type: "insertParagraphAfter", blockId: p.id, text: "A new paragraph that copies its neighbour." }]; }],
    ["insertParagraphAfter.empty", (d) => { const p = para(d, 9); return p && [{ type: "insertParagraphAfter", blockId: p.id }]; }],
    ["insertParagraphBefore", (d) => { const p = para(d, 10); return p && [{ type: "insertParagraphBefore", blockId: p.id, text: "Inserted heading", style: { headingLevel: 2 } }]; }],
    ["insertParagraphBefore.styled", (d) => { const p = para(d, 11); return p && [{ type: "insertParagraphBefore", blockId: p.id, text: "Indented, spaced paragraph before.", style: { headingLevel: 0, indentLeftPt: 36, indentRightPt: 18, firstLineIndentPt: -18, spacingBeforePt: 6, spacingAfterPt: 12, alignment: "justify" } }]; }],
    ["splitParagraph", (d) => { const p = para(d, 12); return p && [{ type: "splitParagraph", at: { blockId: p.id, offset: Math.floor(p.text.length / 2) } }]; }],
    ["deleteParagraph", (d) => { const p = para(d, 13); return p && [{ type: "deleteParagraph", blockId: p.id }]; }],
    ["setRunFormat.bold", (d) => { const p = para(d, 14); return p && [{ type: "setRunFormat", range: { start: { blockId: p.id, offset: 1 }, end: { blockId: p.id, offset: Math.min(9, p.text.length) } }, format: { bold: true, italic: true } }]; }],
    ["setRunFormat.all", (d) => { const p = para(d, 15); return p && [{ type: "setRunFormat", range: { start: { blockId: p.id, offset: 0 }, end: { blockId: p.id, offset: p.text.length } }, format: { underline: true, strike: true, color: "#1f4e79", highlight: "#00ff00", fontSizePt: 9.5, fontFamily: "Courier New", verticalAlign: "subscript" } }]; }],
    ["setRunFormat.off", (d) => { const p = para(d, 14); return p && [{ type: "setRunFormat", range: { start: { blockId: p.id, offset: 3 }, end: { blockId: p.id, offset: Math.min(6, p.text.length) } }, format: { bold: false } }]; }],
    ["setParagraphStyle.layout", (d) => { const p = para(d, 16); return p && [{ type: "setParagraphStyle", blockId: p.id, style: { alignment: "right", indentLeftPt: 18, indentRightPt: 4, firstLineIndentPt: 9, spacingBeforePt: 6, spacingAfterPt: 6 } }]; }],
    ["setParagraphStyle.heading", (d) => { const p = para(d, 17); return p && [{ type: "setParagraphStyle", blockId: p.id, style: { headingLevel: 3 } }]; }],
    ["setParagraphStyle.styleId", (d) => { const p = para(d, 18); const other = bodyParagraphs(d).find((q) => q.style.styleId !== null && q.style.styleId !== p?.style.styleId); return p && other ? [{ type: "setParagraphStyle", blockId: p.id, style: { styleId: other.style.styleId } }] : null; }],
    ["deleteRange.acrossParagraphs", (d) => {
      const list = bodyParagraphs(d);
      const blocks = d.getView().body.blocks;
      for (let i = Math.floor(blocks.length / 2); i + 1 < blocks.length; i++) {
        const a = blocks[i];
        const b = blocks[i + 1];
        if (a?.type === "paragraph" && b?.type === "paragraph" && plain(a, 8) && plain(b, 8) && list.includes(a)) {
          return [{ type: "deleteRange", range: { start: { blockId: a.id, offset: Math.floor(a.text.length / 2) }, end: { blockId: b.id, offset: 3 } } }];
        }
      }
      return null;
    }],
    ["insertTableRow.middle", (d) => { const t = firstTable(d); return t && [{ type: "insertTableRow", tableId: t.id, rowIndex: 1, cells: ["New A", "New B"].slice(0, Math.min(2, t.rows[0]?.cells.length ?? 1)) }]; }],
    ["insertTableRow.append", (d) => { const t = firstTable(d); return t && [{ type: "insertTableRow", tableId: t.id, rowIndex: t.rows.length }]; }],
    ["insertTableRow.first", (d) => { const t = firstTable(d); return t && [{ type: "insertTableRow", tableId: t.id, rowIndex: 0, cells: ["First"] }]; }],
    ["setCellText.words", (d) => { const t = firstTable(d); if (!t) return null; const r = t.rows.length - 2; return r < 0 ? null : [{ type: "setCellText", tableId: t.id, rowIndex: r, cellIndex: 0, text: "Changed cell text here" }]; }],
    ["setCellText.whole", (d) => { const t = firstTable(d); if (!t) return null; const r = t.rows.length - 2; const c = (t.rows[r]?.cells.length ?? 1) - 1; return r < 0 ? null : [{ type: "setCellText", tableId: t.id, rowIndex: r, cellIndex: c, text: "Whole\treplacement", granularity: "whole" }]; }],
    ["deleteTableRow", (d) => { const t = firstTable(d); return t && t.rows.length >= 4 ? [{ type: "deleteTableRow", tableId: t.id, rowIndex: t.rows.length - 3 }] : null; }],
    ["cell.insertText", (d) => {
      const t = firstTable(d);
      const cell = t?.rows[t.rows.length - 1]?.cells[0]?.blocks[0];
      return cell && cell.type === "paragraph" ? [{ type: "insertText", at: { blockId: cell.id, offset: cell.text.length }, text: " (cell note)" }] : null;
    }],
    ["header.insertText", (d) => { const b = d.getView().headers[0]?.blocks.find((x) => x.type === "paragraph"); return b && b.type === "paragraph" ? [{ type: "insertText", at: { blockId: b.id, offset: b.text.length }, text: " — draft" }] : null; }],
    ["footnote.replace", (d) => { const b = d.getView().footnotes[0]?.blocks.find((x) => x.type === "paragraph" && x.text.replace(/￼/g, "").trim().length > 6); if (!b || b.type !== "paragraph") return null; return [{ type: "insertText", at: { blockId: b.id, offset: b.text.length }, text: " See also the schedule." }]; }],
    ["addComment", (d) => { const p = para(d, 19); return p && [{ type: "addComment", range: { start: { blockId: p.id, offset: 0 }, end: { blockId: p.id, offset: Math.min(6, p.text.length) } }, text: "Please check this.\nSecond paragraph of the comment & <more>." }]; }],
    ["addComment.overlap", (d) => { const p = para(d, 19); return p && [{ type: "addComment", range: { start: { blockId: p.id, offset: 2 }, end: { blockId: p.id, offset: Math.min(12, p.text.length) } }, text: "Overlapping comment." }]; }],
    ["replyComment", (d) => { const c = d.listComments(); const last = c[c.length - 1]; return last ? [{ type: "replyComment", commentId: last.id, text: "Reply to the last thread." }] : null; }],
    ["replyComment.first", (d) => { const c = d.listComments()[0]; return c ? [{ type: "replyComment", commentId: c.id, text: "Reply to the first thread." }] : null; }],
    ["resolveComment", (d) => { const c = d.listComments()[0]; return c ? [{ type: "resolveComment", commentId: c.id }] : null; }],
    ["addComment.multiParagraph", (d) => {
      const blocks = d.getView().body.blocks;
      for (let i = 0; i + 1 < blocks.length; i++) {
        const a = blocks[i];
        const b = blocks[i + 1];
        if (a?.type === "paragraph" && b?.type === "paragraph" && a.text.length > 4 && b.text.length > 4 && a.markRevision === null) {
          return [{ type: "addComment", range: { start: { blockId: a.id, offset: 1 }, end: { blockId: b.id, offset: 3 } }, text: "Spans two paragraphs." }];
        }
      }
      return null;
    }],
  ];
  // Hazards: edits that cut through links, fields, notes, comment anchors, bookmarks and merged cells.
  type Run = ParagraphBlock["runs"][number];
  const findRun = (d: DocxDocument, test: (run: Run, p: ParagraphBlock) => boolean, nth = 0): { p: ParagraphBlock; run: Run } | null => {
    let seen = 0;
    for (const p of bodyParagraphs(d)) {
      if (p.markRevision !== null) continue;
      for (const run of p.runs) if (run.revision === null && test(run, p) && seen++ === nth) return { p, run };
    }
    return null;
  };
  const span = (p: ParagraphBlock, from: number, to: number) => ({ start: { blockId: p.id, offset: Math.max(0, from) }, end: { blockId: p.id, offset: Math.min(p.text.length, to) } });
  const isLink = (run: Run) => run.hyperlink !== null && run.field === null;
  const isField = (run: Run) => run.field !== null;
  steps.push(
    ["hazard.link.insertInside", (d) => { const f = findRun(d, isLink); return f && [{ type: "insertText", at: { blockId: f.p.id, offset: f.run.start + 1 }, text: "IN" }]; }],
    ["hazard.link.deleteAcrossStart", (d) => { const f = findRun(d, isLink); return f && f.run.start >= 2 ? [{ type: "deleteRange", range: span(f.p, f.run.start - 2, f.run.start + 3) }] : null; }],
    ["hazard.link.formatAcrossEnd", (d) => { const f = findRun(d, isLink, 1) ?? findRun(d, isLink); if (!f) return null; const end = f.run.start + f.run.text.length; return [{ type: "setRunFormat", range: span(f.p, end - 2, end + 2), format: { bold: true } }]; }],
    ["hazard.link.replaceAcrossEnd", (d) => { const f = findRun(d, isLink, 1); if (!f) return null; const end = f.run.start + f.run.text.length; return [{ type: "replaceRange", range: span(f.p, end - 1, end + 3), text: "XY Z" }]; }],
    ["hazard.link.split", (d) => { const f = findRun(d, isLink, 1) ?? findRun(d, isLink); return f && f.run.text.length > 3 ? [{ type: "splitParagraph", at: { blockId: f.p.id, offset: f.run.start + 2 } }] : null; }],
    ["hazard.field.deleteAcross", (d) => { const f = findRun(d, isField); return f ? [{ type: "deleteRange", range: span(f.p, f.run.start - 2, f.run.start + 2) }] : null; }],
    ["hazard.field.insertInside", (d) => { const f = findRun(d, isField, 1); return f ? [{ type: "insertText", at: { blockId: f.p.id, offset: f.run.start + 1 }, text: "f" }] : null; }],
    ["hazard.field.replaceParagraph", (d) => { const f = findRun(d, isField, 2); return f ? [{ type: "replaceRange", range: span(f.p, 0, f.p.text.length), text: "Field paragraph replaced", granularity: "words" }] : null; }],
    ["hazard.field.deleteParagraph", (d) => { const f = findRun(d, isField, 3); return f ? [{ type: "deleteParagraph", blockId: f.p.id }] : null; }],
    ["hazard.note.deleteReference", (d) => { const f = findRun(d, (run) => run.footnoteRef !== null); return f ? [{ type: "deleteRange", range: span(f.p, f.run.start - 3, f.run.start + 1) }] : null; }],
    ["hazard.note.replaceAround", (d) => { const f = findRun(d, (run) => run.footnoteRef !== null, 1); return f ? [{ type: "replaceRange", range: span(f.p, 0, f.p.text.length), text: f.p.text.replace(/\uFFFC/g, "").toUpperCase(), granularity: "words" }] : null; }],
    ["hazard.object.delete", (d) => { const f = findRun(d, (run) => run.object !== null && run.footnoteRef === null); return f ? [{ type: "deleteRange", range: span(f.p, f.run.start - 1, f.run.start + 1) }] : null; }],
    ["hazard.comment.deleteAcrossStart", (d) => { const f = findRun(d, (run) => run.commentIds.length > 0); return f && f.run.start >= 2 ? [{ type: "deleteRange", range: span(f.p, f.run.start - 2, f.run.start + 2) }] : null; }],
    ["hazard.comment.deleteWholeAnchor", (d) => { const c = d.listComments().filter((x) => x.parentId === null && x.range !== null && x.range.start.blockId === x.range.end.blockId && x.range.end.offset > x.range.start.offset); const t = c[c.length - 1]; return t && t.range ? [{ type: "deleteRange", range: t.range }] : null; }],
    ["hazard.comment.deleteParagraph", (d) => { const f = findRun(d, (run) => run.commentIds.length > 0, 1); return f ? [{ type: "deleteParagraph", blockId: f.p.id }] : null; }],
    ["hazard.bookmark.deleteParagraph", (d) => { const p = bodyParagraphs(d).find((x) => x.bookmarks.length > 0 && x.markRevision === null && x.text.length > 0); return p ? [{ type: "deleteParagraph", blockId: p.id }] : null; }],
    ["hazard.bookmark.deleteStart", (d) => { const p = bodyParagraphs(d).filter((x) => x.bookmarks.length > 0 && x.markRevision === null && x.text.length > 4)[1]; return p ? [{ type: "deleteRange", range: span(p, 0, 3) }] : null; }],
    ["hazard.threeParagraphs", (d) => {
      const blocks = d.getView().body.blocks;
      for (let i = 1; i + 2 < blocks.length; i++) {
        const [a, b, c] = [blocks[i], blocks[i + 1], blocks[i + 2]];
        if (a?.type === "paragraph" && b?.type === "paragraph" && c?.type === "paragraph" && a.text.length > 3 && c.text.length > 3 && [a, b, c].every((x) => x.markRevision === null)) {
          return [{ type: "deleteRange", range: { start: { blockId: a.id, offset: 2 }, end: { blockId: c.id, offset: 2 } } }];
        }
      }
      return null;
    }],
    ["hazard.beforeTable.delete", (d) => { const blocks = d.getView().body.blocks; const i = blocks.findIndex((b) => b.type === "table"); const p = i > 0 ? blocks[i - 1] : undefined; return p && p.type === "paragraph" ? [{ type: "deleteParagraph", blockId: p.id }] : null; }],
    ["hazard.afterTable.insert", (d) => { const t = firstTable(d); return t && [{ type: "insertParagraphAfter", blockId: t.id, text: "After the table." }]; }],
    ["hazard.beforeTable.insert", (d) => { const t = firstTable(d); return t && [{ type: "insertParagraphBefore", blockId: t.id, text: "Before the table." }]; }],
    ["hazard.cell.deleteOnlyParagraph", (d) => { const t = firstTable(d); const cell = t?.rows[1]?.cells[0]; const b = cell?.blocks[0]; return b && b.type === "paragraph" ? [{ type: "deleteParagraph", blockId: b.id }] : null; }],
    ["hazard.cell.split", (d) => { const t = firstTable(d); const b = t?.rows[1]?.cells[1]?.blocks[0]; return b && b.type === "paragraph" && b.text.length > 2 ? [{ type: "splitParagraph", at: { blockId: b.id, offset: 1 } }] : null; }],
    ["hazard.cell.insertParagraph", (d) => { const t = firstTable(d); const cells = t?.rows[2]?.cells; const b = cells?.[cells.length - 1]?.blocks[0]; return b && b.type === "paragraph" ? [{ type: "insertParagraphAfter", blockId: b.id, text: "Second paragraph in the cell" }] : null; }],
    ["hazard.mergedRow.delete", (d) => { const t = firstTable(d); if (!t) return null; const r = t.rows.findIndex((row) => row.revision === null && row.cells.some((cell) => cell.rowSpan > 1 || cell.mergedAbove)); return r >= 0 && t.rows.length > 2 ? [{ type: "deleteTableRow", tableId: t.id, rowIndex: r }] : null; }],
    ["hazard.spannedRow.insertAfter", (d) => { const t = firstTable(d); if (!t) return null; const r = t.rows.findIndex((row) => row.cells.some((cell) => cell.colSpan > 1)); return r >= 0 ? [{ type: "insertTableRow", tableId: t.id, rowIndex: r + 1, cells: ["after span"] }] : null; }],
    ["hazard.spannedCell.setText", (d) => { const t = firstTable(d); if (!t) return null; for (let r = 0; r < t.rows.length; r++) { const c = t.rows[r]!.cells.findIndex((cell) => cell.colSpan > 1); if (c >= 0 && t.rows[r]!.revision === null) return [{ type: "setCellText", tableId: t.id, rowIndex: r, cellIndex: c, text: "Spanned title changed" }]; } return null; }],
    ["hazard.footer.deleteField", (d) => { const b = d.getView().footers[0]?.blocks.find((x) => x.type === "paragraph" && x.text.length > 2); return b && b.type === "paragraph" ? [{ type: "deleteRange", range: span(b, 0, b.text.length) }] : null; }],
    ["hazard.footer.insert", (d) => { const b = d.getView().footers[0]?.blocks.find((x) => x.type === "paragraph"); return b && b.type === "paragraph" ? [{ type: "insertText", at: { blockId: b.id, offset: 0 }, text: "Confidential " }] : null; }],
    ["hazard.footnote.deleteAll", (d) => { const b = d.getView().footnotes[1]?.blocks.find((x) => x.type === "paragraph"); return b && b.type === "paragraph" ? [{ type: "deleteRange", range: span(b, 0, b.text.length) }] : null; }],
    ["hazard.footnote.newParagraph", (d) => { const b = d.getView().footnotes[0]?.blocks.find((x) => x.type === "paragraph"); return b && b.type === "paragraph" ? [{ type: "insertParagraphAfter", blockId: b.id, text: "Second paragraph of the note." }] : null; }],
    ["hazard.lastParagraph.delete", (d) => { const all2 = bodyParagraphs(d); const last = all2[all2.length - 1]; return last ? [{ type: "deleteParagraph", blockId: last.id }] : null; }],
    ["hazard.firstParagraph.before", (d) => { const first = d.getView().body.blocks[0]; return first && first.type !== "sectionBreak" ? [{ type: "insertParagraphBefore", blockId: first.id, text: "Very first paragraph." }] : null; }],
    ["hazard.comment.onInserted", (d) => { const f = findRun(d, () => false); void f; for (const p of bodyParagraphs(d)) for (const run of p.runs) if (run.revision?.kind === "insert" && run.text.length > 3 && run.commentIds.length === 0) return [{ type: "addComment", range: span(p, run.start, run.start + 3), text: "On inserted text." }]; return null; }],
    ["hazard.comment.onDeleted", (d) => { for (const p of bodyParagraphs(d)) for (const run of p.runs) if (run.revision?.kind === "delete" && run.text.length > 3) return [{ type: "addComment", range: span(p, run.start, run.start + 3), text: "On deleted text." }]; return null; }],
  );
  return steps;
}

/** Runs the batch. A step whose target the document lacks is skipped; a step that throws fails the test. */
export function runSteps(doc: DocxDocument, options: ApplyOptions, only?: (name: string) => boolean): string[] {
  const applied: string[] = [];
  for (const [name, make] of editSteps(doc)) {
    if (only !== undefined && !only(name)) continue;
    const ops = make(doc);
    if (ops === null) continue;
    try {
      doc.applyOps(ops, options);
    } catch (error) {
      throw new Error(`step ${name} failed: ${(error as Error).message} ${JSON.stringify(ops)}`);
    }
    applied.push(name);
  }
  return applied;
}

/** True for the steps that add or change comments. */
export const isCommentStep = (name: string): boolean => /^(addComment|replyComment|resolveComment|hazard\.comment\.on)/.test(name);

/** Accepts one revision in three, rejects one in three and leaves the rest pending. */
export function resolvePartially(doc: DocxDocument): void {
  const ids = doc.listRevisions().map((revision) => revision.id);
  ids.forEach((id, position) => {
    if (position % 3 === 2 || !doc.listRevisions().some((revision) => revision.id === id)) return;
    if (position % 3 === 0) doc.acceptRevisions([id]);
    else doc.rejectRevisions([id]);
  });
}
