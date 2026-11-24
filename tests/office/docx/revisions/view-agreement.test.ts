/**
 * A view of the pending changes must show what resolving them gives: the
 * `final` text is the text after accepting everything and the `original`
 * text the text after rejecting everything. These cases are about a
 * paragraph whose mark is gone in a view and that has no paragraph after it
 * to run on into.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { toHtml, toMarkdown, toPlainText } from "../../../../packages/office/src/docx/index.js";
import { DATE, RAE, TRACKED, build, paragraphs } from "../edit/helpers.js";
import { cell, p, r, row, tbl } from "../model/build.js";

const TABLE = tbl(row(cell(p(r("A1"))) + cell(p(r("B1")))));
const DELETED_MARK = `<w:rPr><w:del w:id="90" w:author="${RAE}" w:date="${DATE}"/></w:rPr>`;
const INSERTED_MARK = `<w:rPr><w:ins w:id="91" w:author="${RAE}" w:date="${DATE}"/></w:rPr>`;
const deletedRun = (text: string): string => `<w:del w:id="92" w:author="${RAE}" w:date="${DATE}"><w:r><w:delText>${text}</w:delText></w:r></w:del>`;
const insertedRun = (text: string): string => `<w:ins w:id="93" w:author="${RAE}" w:date="${DATE}"><w:r><w:t>${text}</w:t></w:r></w:ins>`;

/** Checks every text view of the document against the document with its changes resolved. */
function expectViewsToAgree(make: () => DocxDocument): { final: string; original: string } {
  const doc = make();
  const final = doc.getPlainText({ view: "final" });
  const original = doc.getPlainText({ view: "original" });
  const accepted = make();
  accepted.acceptRevisions("all");
  const rejected = make();
  rejected.rejectRevisions("all");
  expect(final).toBe(accepted.getPlainText());
  expect(original).toBe(rejected.getPlainText());
  expect(toPlainText(doc, { view: "final", numberingLabels: false })).toBe(final);
  expect(toPlainText(doc, { view: "original", numberingLabels: false })).toBe(original);
  expect(toHtml(doc, { mode: "final", fragment: true })).toBe(toHtml(accepted, { mode: "final", fragment: true }));
  expect(toHtml(doc, { mode: "original", fragment: true })).toBe(toHtml(rejected, { mode: "original", fragment: true }));
  expect(toMarkdown(doc, { view: "final" })).toBe(toMarkdown(accepted));
  return { final, original };
}

describe("a paragraph whose mark is gone in a view", () => {
  it("is left out before a table when it has no content left", () => {
    const body = p(r("Intro.")) + p(deletedRun("Gone."), DELETED_MARK) + TABLE + p(r("After."));
    const views = expectViewsToAgree(() => build({ body }));
    expect(views.final).toBe("Intro.\nA1\tB1\nAfter.\n");
    expect(views.original).toBe("Intro.\nGone.\nA1\tB1\nAfter.\n");
  });

  it("is left out before a table in the original view when it was inserted", () => {
    const body = p(r("Intro.")) + p(insertedRun("New."), INSERTED_MARK) + TABLE + p(r("After."));
    const views = expectViewsToAgree(() => build({ body }));
    expect(views.final).toBe("Intro.\nNew.\nA1\tB1\nAfter.\n");
    expect(views.original).toBe("Intro.\nA1\tB1\nAfter.\n");
  });

  it("stays before a table when it still has content", () => {
    const body = p(r("Kept text.") + deletedRun(" Gone."), DELETED_MARK) + TABLE + p(r("After."));
    const views = expectViewsToAgree(() => build({ body }));
    expect(views.final).toBe("Kept text.\nA1\tB1\nAfter.\n");
  });

  it("is left out at the end of a story after a paragraph, and after joined paragraphs before a table", () => {
    const atEnd = p(r("Intro.")) + p(deletedRun("Gone."), DELETED_MARK);
    expect(expectViewsToAgree(() => build({ body: atEnd })).final).toBe("Intro.\n");
    const joined = p(deletedRun("One."), DELETED_MARK) + p(deletedRun("Two."), DELETED_MARK) + TABLE + p(r("After."));
    expect(expectViewsToAgree(() => build({ body: joined })).final).toBe("A1\tB1\nAfter.\n");
  });

  it("is what a tracked deletion of a paragraph before a table produces", () => {
    const make = (): DocxDocument => {
      const doc = build({ body: p(r("Intro.")) + p(r("Gone.")) + TABLE + p(r("After.")) });
      doc.applyOps([{ type: "deleteParagraph", blockId: paragraphs(doc)[1]?.id ?? "" }], TRACKED);
      return doc;
    };
    expect(expectViewsToAgree(make).final).toBe("Intro.\nA1\tB1\nAfter.\n");
  });
});
