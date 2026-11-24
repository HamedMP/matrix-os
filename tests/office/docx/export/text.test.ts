import { describe, expect, it } from "vitest";

import type { DocxTextView } from "../../../../packages/office/src/api/docx.js";
import { createDocx, createDocxFromMarkdown, toMarkdown, toPlainText } from "../../../../packages/office/src/docx/index.js";
import { buildDocument, p, r } from "../model/build.js";
import { DOCX_FIXTURES, expectedText, openFixture } from "../model/helpers.js";

const VIEWS: readonly DocxTextView[] = ["markup", "final", "original"];

describe("toPlainText", () => {
  for (const name of DOCX_FIXTURES) {
    it(`${name}: agrees with getPlainText in every view when labels are off`, async () => {
      const doc = await openFixture(name);
      for (const view of VIEWS) {
        expect(toPlainText(doc, { view, numberingLabels: false })).toBe(doc.getPlainText({ view }));
      }
    });
  }

  it("tracked.docx: matches the independent accept and reject texts", async () => {
    const doc = await openFixture("tracked.docx");
    const norm = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(norm(toPlainText(doc))).toBe(norm(expectedText("tracked.docx.txt")));
    expect(norm(toPlainText(doc, { view: "original" }))).toBe(norm(expectedText("tracked.docx.reject.txt")));
  });

  it("numbering.docx: starts numbered paragraphs with their label and a tab", async () => {
    const lines = toPlainText(await openFixture("numbering.docx")).split("\n");
    expect(lines).toContain("1.\tScope of work");
    expect(lines).toContain("1.1.\tDiscovery workshops");
    expect(lines).toContain("(a)\tStakeholder interviews");
    expect(lines).toContain("•\tCoffee");
  });
});

describe("toMarkdown", () => {
  it("basic.docx: headings without implied bold, inline emphasis, quotes", async () => {
    const markdown = toMarkdown(await openFixture("basic.docx"));
    expect(markdown).toMatch(/^# Quarterly Operations Review\n\n# Summary\n/);
    expect(markdown).toContain("## Revenue");
    expect(markdown).toContain("the **third quarter** and highlights *three* priorities");
    expect(markdown).toContain("***Bold italic underlined***");
    expect(markdown).toContain("> *A quotation to finish the review.*");
  });

  it("numbering.docx: nested lists with their own counters", async () => {
    const markdown = toMarkdown(await openFixture("numbering.docx"));
    expect(markdown).toContain("1. Scope of work\n   1. Discovery workshops\n      1. Stakeholder interviews\n      2. Current-state");
    expect(markdown).toContain("- Coffee\n- Tea\n  - Green tea\n- Water");
    expect(markdown).toContain("1. Collect feedback");
  });

  it("table.docx: a pipe table that keeps merged columns in place", async () => {
    const markdown = toMarkdown(await openFixture("table.docx"));
    expect(markdown).toContain("| Budget by phase (EUR) |  |  |  |\n| --- | --- | --- | --- |");
    expect(markdown).toContain("| Build |  | 30,000 | 42,000 |");
  });

  it("footnotes-headers.docx: footnote references and definitions", async () => {
    const markdown = toMarkdown(await openFixture("footnotes-headers.docx"));
    expect(markdown).toContain("most teams[^1] although");
    expect(markdown).toContain("[^3]: Subject to budget approval.");
  });

  it("tracked.docx: views, and deletions struck through in markup", async () => {
    const doc = await openFixture("tracked.docx");
    expect(toMarkdown(doc)).toContain("within fifteen business days");
    expect(toMarkdown(doc, { view: "original" })).toContain("within ten business days");
    expect(toMarkdown(doc, { view: "markup" })).toContain("within ~~ten~~fifteen business days");
  });

  it("links-fields.docx: safe links are kept", async () => {
    expect(toMarkdown(await openFixture("links-fields.docx"))).toContain("[terms of service](https://example.com/terms)");
  });

  it("escapes document text so it cannot become Markdown or HTML", async () => {
    const text = '<script>alert(1)</script> *not bold* [x](javascript:y) # 1. | `tick` &amp;';
    const markdown = toMarkdown(createDocx({ paragraphs: [text, "- not a list", "2. not a list"] }));
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("\\<script\\>");
    const reimported = createDocxFromMarkdown(markdown);
    expect(reimported.getPlainText()).toBe(`${text}\n- not a list\n2. not a list\n`);
  });

  it("drops unsafe link targets", () => {
    const doc = buildDocument({
      body: p(`<w:hyperlink r:id="rId9">${r("click")}</w:hyperlink>`),
      links: { rId9: "javascript:alert(1)" },
    });
    expect(toMarkdown(doc)).toBe("click\n");
  });

  it("every fixture exports without throwing and re-imports to the same text", async () => {
    for (const name of DOCX_FIXTURES) {
      const doc = await openFixture(name);
      const markdown = toMarkdown(doc);
      const words = (value: string) => value.replace(/[\s￼­]+/g, " ").trim();
      const reimported = createDocxFromMarkdown(markdown);
      // Footnote definitions are re-imported as paragraphs; compare the body part only.
      const body = reimported.getPlainText().split(/\n\[\^/)[0] as string;
      expect(words(body.replace(/\[\^\w+\]/g, ""))).toBe(words(toPlainText(doc, { numberingLabels: false })));
    }
  });
});
