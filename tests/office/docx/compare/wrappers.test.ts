import { describe, expect, it } from "vitest";

import type { ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { buildDocx, compared, describeRevisions, p, r, reopen } from "./helpers.js";

/*
 * Inline wrappers (content controls, fields, smart tags) and block-level
 * content controls: revisions go inside them, and a wrapper is only cut in
 * two when a paragraph is split in the middle of it.
 */

const control = (id: number, content: string): string =>
  `<w:sdt><w:sdtPr><w:alias w:val="Party"/><w:id w:val="${id}"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;

const field = (instruction: string, result: string): string =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

describe("inline wrappers", () => {
  it("tracks a change inside an inline content control and keeps the control", async () => {
    const original = await buildDocx({ body: p(r("Between ") + control(7, r("Harbourline Analytics Ltd")) + r(" and the Supplier.")) });
    const revised = await buildDocx({ body: p(r("Between ") + control(7, r("Harbourline Analytics Limited")) + r(" and the Supplier.")) });
    const document = await compared(original, revised);
    expect(describeRevisions(document)).toEqual([
      ["delete", "text", "Ltd"],
      ["insert", "text", "Limited"],
    ]);
    const xml = await (await reopen(document)).package.getPartText("/word/document.xml");
    expect((xml.match(/<w:sdt>/g) ?? []).length).toBe(1);
    expect(xml).toMatch(/<w:sdtContent>.*<w:del .*<w:ins .*<\/w:sdtContent>/s);
  });

  it("cuts a content control in two when the paragraph is split inside it", async () => {
    const original = await buildDocx({
      body: p(r("Intro. ") + control(7, r("The first sentence is long enough. The second sentence is long enough too.")) + r(" Outro.")),
    });
    const revised = await buildDocx({
      body:
        p(r("Intro. ") + control(7, r("The first sentence is long enough."))) +
        p(control(8, r("The second sentence is long enough too.")) + r(" Outro.")),
    });
    const document = await compared(original, revised);
    expect(document.getView().body.blocks).toHaveLength(2);
    const xml = await (await reopen(document)).package.getPartText("/word/document.xml");
    expect((xml.match(/<w:sdt>/g) ?? []).length).toBe(2);
    expect((xml.match(/<w:id w:val="7"\/>/g) ?? []).length).toBe(1);
  });

  it("tracks a changed field result and a deleted paragraph that holds a field", async () => {
    const original = await buildDocx({
      body: p(r("See clause ") + field("REF _Ref1 \\r \\h", "8.1") + r(" for the cap.")) + p(r("Printed on ") + field("DATE", "1 March 2027") + r(".")) + p(r("Last paragraph stays.")),
    });
    const changed = await buildDocx({
      body: p(r("See clause ") + field("REF _Ref1 \\r \\h", "8.2") + r(" for the cap.")) + p(r("Printed on ") + field("DATE", "1 March 2027") + r(".")) + p(r("Last paragraph stays.")),
    });
    const first = await compared(original, changed);
    expect(describeRevisions(first)).toEqual([
      ["delete", "text", "1"],
      ["insert", "text", "2"],
    ]);
    const paragraph = first.getView().body.blocks[0] as ParagraphBlock;
    expect(paragraph.runs.filter((run) => run.field !== null).map((run) => run.field?.kind)).toContain("ref");

    const removed = await buildDocx({ body: p(r("See clause ") + field("REF _Ref1 \\r \\h", "8.1") + r(" for the cap.")) + p(r("Last paragraph stays.")) });
    const second = await compared(original, removed);
    expect(describeRevisions(second)).toEqual([["delete", "text", "Printed on 1 March 2027.\n"]]);
    const xml = await (await reopen(second)).package.getPartText("/word/document.xml");
    expect(xml).toContain("<w:delInstrText");

    const third = await compared(removed, original);
    expect(describeRevisions(third)).toEqual([["insert", "text", "Printed on 1 March 2027.\n"]]);
    const inserted = third.getView().body.blocks[1] as ParagraphBlock;
    expect(inserted.runs.some((run) => run.field?.kind === "date")).toBe(true);
  });

  it("tracks a change inside a simple field and a smart tag", async () => {
    const simple = (text: string): string => `<w:fldSimple w:instr=" AUTHOR ">${r(text)}</w:fldSimple>`;
    const tagged = (text: string): string => `<w:smartTag w:uri="urn:example" w:element="place">${r(text)}</w:smartTag>`;
    const original = await buildDocx({ body: p(r("Written by ") + simple("Dana Reviewer") + r(" in ") + tagged("Bristol harbour") + r(".")) });
    const revised = await buildDocx({ body: p(r("Written by ") + simple("Dana Ellis Reviewer") + r(" in ") + tagged("Leeds harbour") + r(".")) });
    const document = await compared(original, revised);
    expect(describeRevisions(document)).toEqual([
      ["insert", "text", "Ellis "],
      ["delete", "text", "Bristol"],
      ["insert", "text", "Leeds"],
    ]);
  });
});

describe("block-level content controls", () => {
  it("compares the paragraphs inside the control and keeps new ones in it", async () => {
    const block = (content: string): string => `<w:sdt><w:sdtPr><w:id w:val="3"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;
    const original = await buildDocx({
      body: p(r("Before the control.")) + block(p(r("First controlled paragraph.")) + p(r("Second controlled paragraph."))) + p(r("After the control.")),
    });
    const revised = await buildDocx({
      body:
        p(r("Before the control.")) +
        block(p(r("First controlled paragraph.")) + p(r("A newly added controlled line.")) + p(r("Second controlled paragraph, edited."))) +
        p(r("After the control.")),
    });
    const document = await compared(original, revised);
    expect(describeRevisions(document).map(([kind]) => kind)).toEqual(["insert", "insert"]);
    const xml = await (await reopen(document)).package.getPartText("/word/document.xml");
    expect(xml).toMatch(/<w:sdtContent>(?:(?!<\/w:sdtContent>).)*A newly added controlled line\./s);
  });
});
