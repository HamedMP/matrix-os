import { describe, expect, it } from "vitest";

import type { CrossReference, DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { hyperlinkOfField, parseFieldInstruction } from "../../../../packages/office/src/docx/internal.js";
import { openFixture, paragraphStarting } from "./helpers.js";

describe("outline", () => {
  it("lists the headings of contract.docx with their levels", async () => {
    const document = await openFixture("contract.docx");
    const outline = document.getOutline();
    expect(outline.map((item) => item.text)).toEqual([
      "Parties",
      "Background",
      "1. Definitions and interpretation",
      "2. Term",
      "3. Services",
      "4. Service levels",
      "5. Charges and payment",
      "6. Intellectual property",
      "7. Confidentiality",
      "8. Limitation of liability",
      "9. Insurance",
      "10. Termination",
      "11. Data protection",
      "12. General",
      "Signatures",
      "Schedule 1 – Service description",
    ]);
    expect(outline.every((item) => item.level === 1 && item.numberingLabel === null)).toBe(true);
    for (const item of outline) expect(document.getBlock(item.blockId)).toMatchObject({ type: "paragraph", text: item.text });
  });

  it("reports nested levels (basic.docx) and numbering labels of numbered headings", async () => {
    const outline = (await openFixture("basic.docx")).getOutline();
    expect(outline.map((item) => [item.level, item.text])).toEqual([
      [1, "Summary"],
      [1, "Details"],
      [2, "Revenue"],
      [2, "Costs"],
    ]);
  });
});

describe("defined terms (contract.docx)", () => {
  it("finds the terms of the definitions clause with their definitions", async () => {
    const terms = (await openFixture("contract.docx")).getDefinedTerms();
    const defining = terms.filter((term) => /^(means|has the meaning)/.test(term.definition));
    expect(defining.map((term) => term.term)).toEqual([
      "Agreement",
      "Business Day",
      "Change Request",
      "Charges",
      "Commencement Date",
      "Confidential Information",
      "Deliverables",
      "Intellectual Property Rights",
      "Service Levels",
      "Services",
      "Term",
    ]);
    expect(defining.every((term) => term.marker === "quoted")).toBe(true);
    expect(defining[0]?.definition).toBe("means this services agreement, including any schedules.");
    expect(defining[10]?.definition).toBe("has the meaning given in clause 2.1.");
    expect(terms.some((term) => term.term === "Customer Data")).toBe(false);
  });

  it("gives the range of the term without its quotation marks", async () => {
    const document = await openFixture("contract.docx");
    for (const term of document.getDefinedTerms()) {
      expect(term.range.start.blockId).toBe(term.blockId);
      expect(document.getPlainText({ range: term.range })).toBe(term.term);
    }
  });

  it("finds terms defined in passing, in parentheses", async () => {
    const terms = (await openFixture("contract.docx")).getDefinedTerms();
    const inPassing = terms.filter((term) => !/^(means|has the meaning)/.test(term.definition));
    expect(inPassing.map((term) => term.term)).toEqual(["Customer", "Supplier", "Term"]);
    expect(inPassing[0]?.definition).toMatch(/^Harbourline Analytics Ltd, a company registered in England/);
    expect(inPassing[2]?.definition).toBe(
      "This Agreement starts on the Commencement Date and continues for an initial period of 24 months",
    );
    // Document order: the parties come before the definitions clause.
    expect(terms.map((term) => term.term).slice(0, 3)).toEqual(["Customer", "Supplier", "Agreement"]);
  });

  it("finds a bold quoted term followed by a defining phrase in another document", async () => {
    const terms = (await openFixture("links-fields.docx")).getDefinedTerms();
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ term: "Service", definition: "means the hosted product.", marker: "quoted" });
  });
});

describe("cross-references", () => {
  const targetStart = (document: DocxDocument, reference: CrossReference): string | null => {
    const block = reference.targetBlockId === null ? null : document.getBlock(reference.targetBlockId);
    return block !== null && block.type === "paragraph" ? block.text : null;
  };

  it("resolves typed clause references in contract.docx to the labelled paragraph", async () => {
    const document = await openFixture("contract.docx");
    const references = document.getCrossReferences();
    expect(references.map((r) => [r.text, r.targetLabel, r.broken])).toEqual([
      ["clause 5", "5.", false],
      ["clause 4", "4.", false],
      ["clause 3", "3.", false],
      ["clause 2.1", "2.1", false],
      ["clause 10", "10.", false],
      ["clause 4.1", "4.1", false],
      ["clause 10.2(b)", "(b)", false],
      ["Clause 7.1", "7.1", false],
      ["clause 7", "7.", false],
      ["clause 8.1", "8.1", false],
      ["clause 8.1", "8.1", false],
      ["clause 4.2", "4.2", false],
      ["clauses 6", "6.", false],
      ["7", "7.", false],
      ["8", "8.", false],
      ["12", "12.", false],
      ["clause 14.3", null, true],
    ]);
    expect(references.every((r) => r.source === "text")).toBe(true);
    const byText = (text: string): CrossReference => references.find((r) => r.text === text) as CrossReference;
    expect(targetStart(document, byText("clause 2.1"))).toMatch(/^2\.1\tThis Agreement starts on the Commencement Date/);
    expect(targetStart(document, byText("clause 10.2(b)"))).toMatch(/^\(b\)\tfails to meet the Service Levels/);
    expect(targetStart(document, byText("clause 5"))).toBe("5. Charges and payment");
    expect(byText("clause 10.2(b)").targetText).toBe(
      "(b)\tfails to meet the Service Levels under clause 4.2 in any three consecutive months; or",
    );
    // A target shorter than the preview limit is quoted whole.
    expect(byText("clause 4.1").targetText).toBe(targetStart(document, byText("clause 4.1")));
    const broken = byText("clause 14.3");
    expect(broken).toMatchObject({ targetBlockId: null, targetLabel: null, targetText: null, broken: true });
  });

  it("gives each reference the range of its text in the paragraph that makes it", async () => {
    const document = await openFixture("contract.docx");
    for (const reference of document.getCrossReferences()) {
      expect(reference.range.start.blockId).toBe(reference.blockId);
      expect(document.getPlainText({ range: reference.range })).toBe(reference.text);
    }
    const first = document.getCrossReferences()[0]!;
    const charges = paragraphStarting(document.getView().body, "“Charges”");
    expect(first.blockId).toBe(charges.id);
  });

  it("resolves fields, links to bookmarks and contents entries in links-fields.docx", async () => {
    const document = await openFixture("links-fields.docx");
    const view = document.getView();
    const introduction = paragraphStarting(view.body, "Introduction");
    const definitions = paragraphStarting(view.body, "Definitions");
    expect(introduction.bookmarks).toEqual(["_Toc1001"]);
    expect(definitions.bookmarks).toEqual(["_Toc1002", "_Ref_Definitions"]);
    const references = document.getCrossReferences();
    expect(references.map((r) => [r.text, r.source, r.targetBlockId, r.broken])).toEqual([
      ["1 Introduction\t1", "field", introduction.id, false],
      ["2 Definitions\t1", "field", definitions.id, false],
      ["definitions", "field", definitions.id, false],
      ["Definitions", "field", definitions.id, false],
      ["1", "field", definitions.id, false],
    ]);
    expect(references[3]?.targetText).toBe("Definitions");
    const explained = paragraphStarting(view.body, "As explained in");
    expect(references[3]?.range).toEqual({
      start: { blockId: explained.id, offset: 16 },
      end: { blockId: explained.id, offset: 27 },
    });
  });

  it("describes hyperlinks and fields on the runs", async () => {
    const view = (await openFixture("links-fields.docx")).getView();
    const read = paragraphStarting(view.body, "Read the full");
    expect(read.runs.map((run) => [run.text, run.hyperlink])).toEqual([
      ["Read the full ", null],
      ["terms of service", { href: "https://example.com/terms", anchor: null, tooltip: null }],
      [" before continuing, or jump to the ", null],
      ["definitions", { href: null, anchor: "_Ref_Definitions", tooltip: null }],
      [".", null],
    ]);
    const definitions = paragraphStarting(view.body, "Definitions");
    const explained = paragraphStarting(view.body, "As explained in");
    expect(explained.text).toBe("As explained in Definitions on page 1, terms are capitalised.");
    const fields = explained.runs.filter((run) => run.field !== null).map((run) => run.field);
    expect(fields).toEqual([
      { fieldId: fields[0]?.fieldId, kind: "ref", instruction: "REF _Ref_Definitions \\h", targetBookmark: "_Ref_Definitions", targetBlockId: definitions.id },
      { fieldId: fields[1]?.fieldId, kind: "pageRef", instruction: "PAGEREF _Ref_Definitions \\h", targetBookmark: "_Ref_Definitions", targetBlockId: definitions.id },
    ]);
    expect(fields[0]?.fieldId).not.toBe(fields[1]?.fieldId);
    // A field that spans paragraphs has one id for all its runs.
    const contents = view.body.blocks.filter((block) => block.type === "paragraph" && block.style.styleId === "TOC1");
    const tocIds = contents.flatMap((block) => (block.type === "paragraph" ? block.runs.map((run) => run.field?.fieldId) : []));
    expect(new Set(tocIds).size).toBe(1);
    expect(tocIds[0]).toBeDefined();
    const printed = paragraphStarting(view.body, "Printed on");
    expect(printed.runs[1]).toMatchObject({ text: "1 January 2026", field: { kind: "date", instruction: 'DATE \\@ "d MMMM yyyy"' } });
  });

  it("parses field codes", () => {
    expect(parseFieldInstruction(" REF _Ref42 \\r \\h ")).toMatchObject({ kind: "ref", type: "REF", instruction: "REF _Ref42 \\r \\h", targetBookmark: "_Ref42" });
    expect(parseFieldInstruction("pageref _Toc7 \\h").kind).toBe("pageRef");
    expect(parseFieldInstruction("NOTEREF _Ref9").targetBookmark).toBe("_Ref9");
    expect(parseFieldInstruction('TOC \\o "1-3" \\h')).toMatchObject({ kind: "toc", targetBookmark: null });
    expect(parseFieldInstruction("MERGEFIELD Name").kind).toBe("other");
    expect(parseFieldInstruction("").kind).toBe("other");
    expect(hyperlinkOfField(parseFieldInstruction('HYPERLINK "https://example.com/a b" \\o "Tip"'))).toEqual({
      href: "https://example.com/a b",
      anchor: null,
      tooltip: "Tip",
    });
    expect(hyperlinkOfField(parseFieldInstruction('HYPERLINK \\l "_Toc5"'))).toEqual({ href: null, anchor: "_Toc5", tooltip: null });
    expect(hyperlinkOfField(parseFieldInstruction("PAGE"))).toBeNull();
  });
});
