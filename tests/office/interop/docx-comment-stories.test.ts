/**
 * Comments live in the body only. A package has one comments part, and it
 * belongs to the main document: a comment anchored in a header, a footer
 * or a note has nowhere valid to point, and other word processors refuse
 * or drop it. The engine used to write such anchors.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument, ParagraphBlock } from "../../../packages/office/src/index.js";
import { isOfficeError, openDocx, parseAgentEdits, toDocxOps } from "../../../packages/office/src/index.js";
import { loadFixture } from "./package.js";
import { AGENT } from "./scenarios.js";
import { wordProblems } from "./wml-rules.js";

function firstParagraph(blocks: readonly { type: string }[] | undefined): ParagraphBlock {
  const found = blocks?.find((block): block is ParagraphBlock => block.type === "paragraph" && (block as ParagraphBlock).text.length > 3);
  if (found === undefined) throw new Error("no paragraph with text");
  return found;
}

function outsideBody(doc: DocxDocument): Array<[string, ParagraphBlock]> {
  const view = doc.getView();
  return [
    ["header", firstParagraph(view.headers[0]?.blocks)],
    ["footer", firstParagraph(view.footers[0]?.blocks)],
    ["footnote", firstParagraph(view.footnotes[0]?.blocks)],
  ];
}

describe("comments outside the body", () => {
  it("are refused, and the document stays as it was", async () => {
    const doc = await openDocx(loadFixture("footnotes-headers.docx"));
    for (const [label, block] of outsideBody(doc)) {
      let code = "";
      try {
        doc.applyOps([{ type: "addComment", range: { start: { blockId: block.id, offset: 0 }, end: { blockId: block.id, offset: 3 } }, text: `On the ${label}.` }], AGENT);
      } catch (error) {
        if (!isOfficeError(error)) throw error;
        code = error.code;
      }
      expect([label, code]).toEqual([label, "invalid_operation"]);
    }
    expect(doc.listComments()).toEqual([]);
    expect(await wordProblems(await doc.save())).toEqual([]);
  });

  it("are refused by the plan of an agent answer, which keeps its other edits", async () => {
    const doc = await openDocx(loadFixture("footnotes-headers.docx"));
    const [, footnote] = outsideBody(doc)[2] as [string, ParagraphBlock];
    const body = firstParagraph(doc.getView().body.blocks);
    const parsed = parseAgentEdits(
      JSON.stringify({
        kind: "docx",
        edits: [
          { op: "comment", blockId: footnote.id, find: "", text: "On a footnote." },
          { op: "comment", blockId: body.id, find: "", text: "On the body." },
        ],
        summary: "Two comments.",
      }),
      "docx",
    );
    if (!parsed.ok || parsed.envelope.kind !== "docx") throw new Error("the answer did not parse");
    const plan = toDocxOps(doc, parsed.envelope.edits);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[0, "invalid_operation"]]);
    expect(plan.opEditIndexes).toEqual([1]);
    doc.applyOps(plan.ops, AGENT);
    expect(doc.listComments().map((comment) => comment.text)).toEqual(["On the body."]);
    expect(await wordProblems(await doc.save())).toEqual([]);
  });

  it("still work in a table cell of the body", async () => {
    const doc = await openDocx(loadFixture("table.docx"));
    const table = doc.getView().body.blocks.find((block) => block.type === "table");
    if (table === undefined || table.type !== "table") throw new Error("no table");
    const cell = firstParagraph(table.rows[1]?.cells[0]?.blocks);
    doc.applyOps([{ type: "addComment", range: { start: { blockId: cell.id, offset: 0 }, end: { blockId: cell.id, offset: 2 } }, text: "On a cell." }], AGENT);
    expect(doc.listComments().map((comment) => comment.text)).toEqual(["On a cell."]);
    expect(await wordProblems(await doc.save())).toEqual([]);
  });
});
