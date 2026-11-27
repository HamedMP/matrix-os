import { describe, expect, it } from "vitest";

import type { DocxDocument, DocxTextView } from "../../../../packages/office/src/api/docx.js";
import { openDocx, toHtml, toMarkdown, toPlainText } from "../../../../packages/office/src/docx/index.js";
import { buildDocument, cell, p, r, row, tbl } from "../model/build.js";

/*
 * `final` and `original` exports read as if every revision were accepted or
 * rejected: formatting comes from the properties the view keeps, and
 * numbering counts only the paragraphs the view keeps. Each case is checked
 * against the same export of the document after accepting or rejecting.
 */

const STAMP = `w:author="Ada Author" w:date="2027-01-01T00:00:00Z"`;
const STYLES =
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>`;
const NUMBERING =
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
const NUMBERED = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`;

const deletedItem = (id: number, text: string): string =>
  p(`<w:del w:id="${id}" ${STAMP}><w:r><w:delText>${text}</w:delText></w:r></w:del>`, `${NUMBERED}<w:rPr><w:del w:id="${id + 1}" ${STAMP}/></w:rPr>`);
const insertedItem = (id: number, text: string): string =>
  p(`<w:ins w:id="${id}" ${STAMP}>${r(text)}</w:ins>`, `${NUMBERED}<w:rPr><w:ins w:id="${id + 1}" ${STAMP}/></w:rPr>`);

const htmlLabels = (html: string): string[] => [...html.matchAll(/<span class="list-label"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1] as string);

async function resolved(doc: DocxDocument, accept: boolean): Promise<DocxDocument> {
  const copy = await openDocx(await doc.save());
  if (accept) copy.acceptRevisions("all");
  else copy.rejectRevisions("all");
  return copy;
}

/** The exports of a view, without the block ids that resolving renumbers. */
function exportsOf(doc: DocxDocument, view: DocxTextView): { html: string; markdown: string; text: string } {
  const html = toHtml(doc, { mode: view, fragment: true })
    .replace(/ data-(?:merged-)?block-ids?="[^"]*"/g, "")
    .replace(/ data-mode="[^"]*"/, "");
  return { html, markdown: toMarkdown(doc, { view }), text: toPlainText(doc, { view }) };
}

async function expectViewsMatchResolved(doc: DocxDocument): Promise<void> {
  expect(exportsOf(doc, "final")).toEqual(exportsOf(await resolved(doc, true), "final"));
  expect(exportsOf(doc, "original")).toEqual(exportsOf(await resolved(doc, false), "final"));
}

describe("exports of a view use the formatting that view keeps", () => {
  it("shows a run that became bold as plain text in the original view", async () => {
    const doc = buildDocument({
      body: p(r("Plain then ") + `<w:r><w:rPr><w:b/><w:rPrChange w:id="1" ${STAMP}><w:rPr/></w:rPrChange></w:rPr><w:t>bold now</w:t></w:r>` + r(".")),
    });
    expect(toHtml(doc, { mode: "final", fragment: true })).toContain("<strong>bold now</strong>");
    expect(toHtml(doc, { mode: "original", fragment: true })).not.toContain("<strong>");
    expect(toMarkdown(doc, { view: "original" })).not.toContain("**");
    expect(toHtml(doc, { mode: "markup", fragment: true })).toContain("<strong>bold now</strong>");
    await expectViewsMatchResolved(doc);
  });

  it("shows the old paragraph style, and the run formatting it implies, in the original view", async () => {
    const doc = buildDocument({
      styles: STYLES,
      body: p(r("A heading now"), `<w:pStyle w:val="Heading1"/><w:pPrChange w:id="1" ${STAMP}><w:pPr/></w:pPrChange>`) + p(r("Body text.")),
    });
    const final = toHtml(doc, { mode: "final", fragment: true });
    expect(final).toMatch(/<h1[^>]*><em>A heading now<\/em><\/h1>/);
    const original = toHtml(doc, { mode: "original", fragment: true });
    expect(original).toMatch(/<p[^>]*>A heading now<\/p>/);
    expect(original).not.toContain("<h1");
    expect(original).not.toContain("<em>");
    expect(toMarkdown(doc, { view: "original" })).not.toContain("#");
    await expectViewsMatchResolved(doc);
  });

  it("shows a paragraph that was numbered only in the view whose properties number it", async () => {
    const doc = buildDocument({
      styles: STYLES,
      numbering: NUMBERING,
      body: p(r("First item"), NUMBERED) + p(r("Newly numbered"), `${NUMBERED}<w:pPrChange w:id="1" ${STAMP}><w:pPr/></w:pPrChange>`) + p(r("Third item"), NUMBERED),
    });
    expect(htmlLabels(toHtml(doc, { mode: "final", fragment: true }))).toEqual(["1.", "2.", "3."]);
    expect(htmlLabels(toHtml(doc, { mode: "original", fragment: true }))).toEqual(["1.", "2."]);
    expect(toPlainText(doc, { view: "original" }).split("\n")).toEqual(["1.\tFirst item", "Newly numbered", "2.\tThird item", ""]);
    await expectViewsMatchResolved(doc);
  });
});

describe("exports of a view number only the paragraphs that view keeps", () => {
  it("does not count a deleted item in the final view or an inserted one in the original view", async () => {
    const doc = buildDocument({
      styles: STYLES,
      numbering: NUMBERING,
      body: p(r("First"), NUMBERED) + deletedItem(1, "Second") + insertedItem(3, "Inserted") + p(r("Last"), NUMBERED),
    });
    expect(htmlLabels(toHtml(doc, { mode: "markup", fragment: true }))).toEqual(["1.", "2.", "3.", "4."]);
    expect(htmlLabels(toHtml(doc, { mode: "final", fragment: true }))).toEqual(["1.", "2.", "3."]);
    expect(toPlainText(doc, { view: "final" }).split("\n")).toEqual(["1.\tFirst", "2.\tInserted", "3.\tLast", ""]);
    expect(toPlainText(doc, { view: "original" }).split("\n")).toEqual(["1.\tFirst", "2.\tSecond", "3.\tLast", ""]);
    expect(toMarkdown(doc, { view: "final" })).toMatch(/^1\. First\n2\. Inserted\n3\. Last\n?$/);
    await expectViewsMatchResolved(doc);
  });

  it("does not count an item in a deleted table row", async () => {
    const doc = buildDocument({
      styles: STYLES,
      numbering: NUMBERING,
      body:
        p(r("Before"), NUMBERED) +
        tbl(row(cell(p(r("In the row"), NUMBERED)), `<w:del w:id="1" ${STAMP}/>`) + row(cell(p(r("Kept row"))))) +
        p(r("After"), NUMBERED),
    });
    expect(toPlainText(doc, { view: "final" }).split("\n")).toEqual(["1.\tBefore", "Kept row", "2.\tAfter", ""]);
    expect(toPlainText(doc, { view: "original" }).split("\n")).toEqual(["1.\tBefore", "2.\tIn the row", "Kept row", "3.\tAfter", ""]);
  });
});
