import { describe, expect, it } from "vitest";
import type { AgentDocxEdit } from "../../../packages/office/src/api/agent.js";
import { describeDocx, parseAgentEdits, toDocxOps } from "../../../packages/office/src/agent/index.js";
import type { DocxDocument, ParagraphBlock } from "../../../packages/office/src/index.js";
import { createDocx, createDocxFromMarkdown, openDocx } from "../../../packages/office/src/index.js";
import { AGENT, TRACKED, bodyParagraphs, openDocxFixture, paragraphStarting } from "./helpers.js";

function make(...paragraphs: string[]): { doc: DocxDocument; ids: string[] } {
  const doc = createDocx({ paragraphs });
  return { doc, ids: bodyParagraphs(doc).map((block) => block.id) };
}

function finalText(doc: DocxDocument): string {
  return doc.getPlainText({ view: "final" });
}

function originalText(doc: DocxDocument): string {
  return doc.getPlainText({ view: "original" });
}

/** Plans the edits, checks that planning changed nothing, applies the plan as tracked changes. */
function planAndApply(doc: DocxDocument, edits: AgentDocxEdit[]): ReturnType<typeof toDocxOps> {
  const before = { final: finalText(doc), markup: doc.getPlainText({ view: "markup" }), revisions: doc.listRevisions().length, comments: doc.listComments().length };
  const plan = toDocxOps(doc, edits);
  expect({ final: finalText(doc), markup: doc.getPlainText({ view: "markup" }), revisions: doc.listRevisions().length, comments: doc.listComments().length }).toEqual(before);
  doc.applyOps(plan.ops, TRACKED);
  return plan;
}

describe("replaceText", () => {
  it("marks only the words that differ", () => {
    const { doc, ids } = make("The Customer shall pay each invoice within 30 days of receipt.");
    const plan = planAndApply(doc, [{ op: "replaceText", blockId: ids[0] as string, find: "invoice within 30 days of receipt", replace: "invoice within 45 days of receipt" }]);
    expect(plan.rejected).toEqual([]);
    expect(plan.opEditIndexes).toEqual([0]);
    expect(plan.ops[0]).toMatchObject({ type: "replaceRange", text: "45", granularity: "words" });
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text, revision.author])).toEqual([
      ["delete", "30", AGENT],
      ["insert", "45", AGENT],
    ]);
    expect(finalText(doc)).toBe("The Customer shall pay each invoice within 45 days of receipt.\n");
    expect(originalText(doc)).toBe("The Customer shall pay each invoice within 30 days of receipt.\n");
  });

  it("never starts or ends a change inside a word", () => {
    const { doc, ids } = make("Payment is due on delivery.");
    planAndApply(doc, [{ op: "replaceText", blockId: ids[0] as string, find: "Payment", replace: "Payments" }]);
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["delete", "Payment"],
      ["insert", "Payments"],
    ]);
  });

  it("turns added words into an insertion and removed words into a deletion", () => {
    const { doc, ids } = make("Either party may terminate on notice.", "The fee is fixed and final.");
    const plan = planAndApply(doc, [
      { op: "replaceText", blockId: ids[0] as string, find: "on notice", replace: "on 30 days’ written notice" },
      { op: "replaceText", blockId: ids[1] as string, find: " and final", replace: "" },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(finalText(doc)).toBe("Either party may terminate on 30 days’ written notice.\nThe fee is fixed.\n");
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["insert", "30 days’ written "],
      ["delete", " and final"],
    ]);
  });

  it("applies several edits to one paragraph, whatever their order in the envelope", () => {
    const { doc, ids } = make("Alpha pays Beta 10 pounds within 20 days and 30 hours.");
    const id = ids[0] as string;
    const plan = planAndApply(doc, [
      { op: "replaceText", blockId: id, find: "10", replace: "11" },
      { op: "replaceText", blockId: id, find: "30 hours", replace: "36 hours" },
      { op: "replaceText", blockId: id, find: "20", replace: "25" },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.opEditIndexes).toEqual([1, 2, 0]);
    expect(finalText(doc)).toBe("Alpha pays Beta 11 pounds within 25 days and 36 hours.\n");
    expect(originalText(doc)).toBe("Alpha pays Beta 10 pounds within 20 days and 30 hours.\n");
  });

  it("uses the occurrence that was asked for and rejects an ambiguous quote", () => {
    const { doc, ids } = make("the cat and the dog and the bird");
    const id = ids[0] as string;
    const plan = planAndApply(doc, [
      { op: "replaceText", blockId: id, find: "the", replace: "a" },
      { op: "replaceText", blockId: id, find: "the", replace: "one", occurrence: 3 },
      { op: "replaceText", blockId: id, find: "the", replace: "x", occurrence: 4 },
      { op: "replaceText", blockId: id, find: "horse", replace: "pony" },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "ambiguous"],
      [2, "stale_reference"],
      [3, "stale_reference"],
    ]);
    expect(finalText(doc)).toBe("the cat and the dog and one bird\n");
  });

  it("finds text in the final view of a paragraph that already has revisions", () => {
    const { doc, ids } = make("Pay within 30 days of the invoice date.");
    const id = ids[0] as string;
    planAndApply(doc, [{ op: "replaceText", blockId: id, find: "30 days", replace: "45 days" }]);
    const second = planAndApply(doc, [
      { op: "replaceText", blockId: id, find: "within 45 days of the invoice", replace: "within 45 days of the delivery" },
      { op: "replaceText", blockId: id, find: "30 days", replace: "60 days" },
    ]);
    expect(second.rejected.map((entry) => [entry.index, entry.code])).toEqual([[1, "stale_reference"]]);
    expect(finalText(doc)).toBe("Pay within 45 days of the delivery date.\n");
    expect(originalText(doc)).toBe("Pay within 30 days of the invoice date.\n");
  });

  it("matches a quote across a line break and keeps the break", () => {
    const { doc, ids } = make("Signed by\nthe Supplier on the date above.");
    const plan = planAndApply(doc, [{ op: "replaceText", blockId: ids[0] as string, find: "by the Supplier on", replace: "by the Customer on" }]);
    expect(plan.rejected).toEqual([]);
    expect(finalText(doc)).toBe("Signed by\nthe Customer on the date above.\n");
  });

  it("leaves a note mark next to the changed words alone and refuses to remove one", async () => {
    const doc = await openDocxFixture("footnotes-headers.docx");
    const block = paragraphStarting(doc, "Remote work");
    const objects = (id: string): number => ((doc.getBlock(id) as ParagraphBlock).runs.filter((run) => run.object !== null && run.revision?.kind !== "delete")).length;
    expect(objects(block.id)).toBe(2);
    const plan = planAndApply(doc, [
      { op: "replaceText", blockId: block.id, find: "most teams although results", replace: "most teams while results" },
      { op: "replaceText", blockId: block.id, find: "output in most teams although", replace: "output in most groups but" },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[1, "invalid_operation"]]);
    expect(objects(block.id)).toBe(2);
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["delete", "although"],
      ["insert", "while"],
    ]);
  });

  it("rejects a block that is missing or not a paragraph, and a replacement that changes nothing", () => {
    const doc = createDocxFromMarkdown("Intro.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const view = doc.getView();
    const table = view.body.blocks.find((block) => block.type === "table");
    const intro = bodyParagraphs(doc)[0] as ParagraphBlock;
    const plan = toDocxOps(doc, [
      { op: "replaceText", blockId: "b404", find: "x", replace: "y" },
      { op: "replaceText", blockId: table?.id ?? "", find: "A", replace: "C" },
      { op: "replaceText", blockId: intro.id, find: "Intro", replace: "Intro" },
    ]);
    expect(plan.ops).toEqual([]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [0, "not_found"],
      [1, "invalid_operation"],
      [2, "invalid_operation"],
    ]);
  });

  it("keeps the first of two edits that change the same words", () => {
    const { doc, ids } = make("The term is 24 months from the start date.");
    const id = ids[0] as string;
    const plan = planAndApply(doc, [
      { op: "replaceText", blockId: id, find: "24 months", replace: "36 months" },
      { op: "replaceText", blockId: id, find: "is 24 months from", replace: "is 12 months from" },
      { op: "replaceText", blockId: id, find: "start date", replace: "commencement date" },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[1, "invalid_operation"]]);
    expect(finalText(doc)).toBe("The term is 36 months from the commencement date.\n");
  });
});

describe("paragraphs and comments", () => {
  it("inserts paragraphs in the order given, after and before a block", () => {
    const { doc, ids } = make("One.", "Two.");
    const plan = planAndApply(doc, [
      { op: "insertParagraph", blockId: ids[0] as string, text: "After one, first." },
      { op: "insertParagraph", blockId: ids[0] as string, text: "After one, second." },
      { op: "insertParagraph", blockId: ids[1] as string, position: "before", text: "Before two, first." },
      { op: "insertParagraph", blockId: ids[1] as string, position: "before", text: "Before two, second." },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(finalText(doc)).toBe("One.\nAfter one, first.\nAfter one, second.\nBefore two, first.\nBefore two, second.\nTwo.\n");
    expect(originalText(doc)).toBe("One.\nTwo.\n");
  });

  it("gives body text placed against a heading the default style, and makes headings on request", async () => {
    const doc = await openDocxFixture("contract.docx");
    const heading = paragraphStarting(doc, "2. Term");
    const plan = toDocxOps(doc, [
      { op: "insertParagraph", blockId: heading.id, text: "This clause sets the term." },
      { op: "insertParagraph", blockId: heading.id, position: "before", text: "1A. Scope", headingLevel: 1 },
    ]);
    const result = doc.applyOps(plan.ops, TRACKED);
    const created = result.createdBlockIds.map((id) => doc.getBlock(id) as ParagraphBlock);
    expect(created.map((block) => [block.text, block.style.headingLevel])).toEqual([
      ["1A. Scope", 1],
      ["This clause sets the term.", 0],
    ]);
    expect((doc.getBlock(heading.id) as ParagraphBlock).style.headingLevel).toBe(1);
  });

  it("deletes a paragraph only when its start is quoted", () => {
    const first = "“Change Request” means a written request by either party to change the scope of the Services.";
    const { doc, ids } = make(first, "Short one.", "Stays.");
    const plan = planAndApply(doc, [
      { op: "deleteParagraph", blockId: ids[0] as string, startsWith: first.slice(0, 40) },
      { op: "deleteParagraph", blockId: ids[1] as string, startsWith: "Short" },
      { op: "deleteParagraph", blockId: ids[2] as string, startsWith: "Remains." },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([
      [1, "stale_reference"],
      [2, "stale_reference"],
    ]);
    expect(finalText(doc)).toBe("Short one.\nStays.\n");
    expect(originalText(doc)).toBe(`${first}\nShort one.\nStays.\n`);
  });

  it("does not change the text of a paragraph that the same envelope deletes", () => {
    const { doc, ids } = make("Clause to remove entirely.", "Kept.");
    const id = ids[0] as string;
    const plan = planAndApply(doc, [
      { op: "deleteParagraph", blockId: id, startsWith: "Clause to remove entirely." },
      { op: "replaceText", blockId: id, find: "remove", replace: "keep" },
      { op: "insertParagraph", blockId: id, text: "Replacement clause." },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[1, "invalid_operation"]]);
    expect(finalText(doc)).toBe("Replacement clause.\nKept.\n");
  });

  it("anchors a comment to quoted text or to the whole paragraph", () => {
    const { doc, ids } = make("The Supplier shall use reasonable endeavours.", "Second paragraph.", "");
    const plan = planAndApply(doc, [
      { op: "comment", blockId: ids[0] as string, find: "reasonable endeavours", text: "Should this be best endeavours?" },
      { op: "comment", blockId: ids[1] as string, find: "", text: "Is this needed?" },
      { op: "comment", blockId: ids[2] as string, find: "", text: "Empty." },
      { op: "replaceText", blockId: ids[0] as string, find: "Supplier", replace: "Provider" },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[2, "invalid_operation"]]);
    expect(doc.listComments().map((comment) => [comment.author, comment.text, comment.anchorText])).toEqual([
      [AGENT, "Should this be best endeavours?", "reasonable endeavours"],
      [AGENT, "Is this needed?", "Second paragraph."],
    ]);
    expect(finalText(doc)).toBe("The Provider shall use reasonable endeavours.\nSecond paragraph.\n\n");
  });

  it("drops only the operation the document refuses and keeps the rest of the plan", () => {
    const { doc, ids } = make("First paragraph.", "Second paragraph.", "Third paragraph.");
    // Not from the parser, which rejects control characters: the document itself refuses this text.
    const plan = planAndApply(doc, [
      { op: "replaceText", blockId: ids[2] as string, find: "Third", replace: "Last" },
      { op: "insertParagraph", blockId: ids[1] as string, text: "bell \u0007 character" },
      { op: "replaceText", blockId: ids[0] as string, find: "First", replace: "Opening" },
    ]);
    expect(plan.rejected.map((entry) => [entry.index, entry.code])).toEqual([[1, "invalid_operation"]]);
    expect(plan.opEditIndexes).toEqual([0, 2]);
    expect(finalText(doc)).toBe("Opening paragraph.\nSecond paragraph.\nLast paragraph.\n");
  });

  it("edits text inside a table cell", () => {
    const doc = createDocxFromMarkdown("| Item | Price |\n| --- | --- |\n| Tea | 3 pounds |\n");
    const line = describeDocx(doc, { maxChars: 10_000 }).text.split("\n").find((entry) => entry.endsWith("3 pounds")) ?? "";
    const id = /^\[(b\d+)\]/.exec(line)?.[1] ?? "";
    const plan = planAndApply(doc, [{ op: "replaceText", blockId: id, find: "3 pounds", replace: "4 pounds" }]);
    expect(plan.rejected).toEqual([]);
    expect(finalText(doc)).toContain("Tea\t4 pounds");
  });
});

describe("from an agent answer to a saved document", () => {
  it("applies a parsed envelope and survives save and reopen", async () => {
    const doc = await openDocxFixture("contract.docx");
    const term = paragraphStarting(doc, "2.1\t");
    const answer = `Proposed edits:\n\`\`\`json\n${JSON.stringify({
      kind: "docx",
      edits: [
        { op: "replaceText", blockId: term.id, find: "24 months", replace: "36 months" },
        { op: "comment", blockId: term.id, find: "clause 10", text: "Check the clause number." },
      ],
      summary: "Extends the term.",
    })}\n\`\`\``;
    const parsed = parseAgentEdits(answer, "docx");
    if (!parsed.ok || parsed.envelope.kind !== "docx") throw new Error("the answer did not parse");
    const plan = toDocxOps(doc, parsed.envelope.edits);
    expect(plan.rejected).toEqual([]);
    doc.applyOps(plan.ops, TRACKED);
    const reopened = await openDocx(await doc.save());
    expect(reopened.listRevisions().map((revision) => [revision.kind, revision.text, revision.author])).toEqual([
      ["delete", "24", AGENT],
      ["insert", "36", AGENT],
    ]);
    expect(reopened.listComments().map((comment) => comment.anchorText)).toEqual(["clause 10"]);
    expect(reopened.getPlainText()).toBe(doc.getPlainText());
  });
});
