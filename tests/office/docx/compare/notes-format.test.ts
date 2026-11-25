import { describe, expect, it } from "vitest";

import type { DocxDocument, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { COMPARE_SELF_CHECK, verifyComparison } from "../../../../packages/office/src/docx/compare/index.js";
import { compareDocx, compareDocxDetailed, openDocx } from "../../../../packages/office/src/docx/index.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";
import { remove } from "../../../../packages/office/src/xml/index.js";
import {
  OPTIONS,
  bodyOf,
  buildDocx,
  describeRevisions,
  footnoteBody,
  footnoteRef,
  loadFixture,
  p,
  r,
  reopen,
  views,
} from "./helpers.js";

const noteTexts = (document: DocxDocument, view: "final" | "original"): string[] =>
  document.getView().footnotes.map((story) => document.getPlainText({ storyId: story.id, view }));

const withNotes = (notes: Record<string, string>, body: string): Promise<Uint8Array> =>
  buildDocx({ body, footnotes: Object.fromEntries(Object.entries(notes).map(([id, text]) => [id, footnoteBody(text)])) });

describe("footnotes", () => {
  const body = p(r("The fee is fixed") + footnoteRef("1") + r(" for the first year.")) + p(r("It may rise afterwards") + footnoteRef("2") + r("."));

  it("compares the text of a footnote that both versions refer to", async () => {
    const original = await withNotes({ "1": "Excluding value added tax.", "2": "By no more than five percent." }, body);
    const revised = await withNotes({ "1": "Excluding value added tax.", "2": "By no more than three percent." }, body);
    const document = await compareDocx(original, revised, OPTIONS);
    expect(describeRevisions(document)).toEqual([
      ["delete", "text", "five"],
      ["insert", "text", "three"],
    ]);
    expect(document.listRevisions().every((revision) => revision.storyId === "footnote:2")).toBe(true);
    const saved = await reopen(document);
    expect(noteTexts(saved, "final")).toEqual([" Excluding value added tax.\n", " By no more than three percent.\n"]);
    expect(noteTexts(saved, "original")).toEqual([" Excluding value added tax.\n", " By no more than five percent.\n"]);
    expect(views(saved).final).toBe(views(saved).original);
  });

  it("pairs footnotes by their reference, not by their id", async () => {
    const original = await withNotes({ "1": "Excluding value added tax.", "2": "By no more than five percent." }, body);
    const renumbered = body.replace('w:id="1"', 'w:id="7"').replace('w:id="2"', 'w:id="4"');
    const revised = await withNotes({ "4": "By no more than five percent.", "7": "Excluding value added tax and duties." }, renumbered);
    const document = await compareDocx(original, revised, OPTIONS);
    expect(describeRevisions(document)).toEqual([["insert", "text", " and duties"]]);
    expect(document.listRevisions()[0]?.storyId).toBe("footnote:1");
  });

  it("brings a footnote that only the revised version has into the result", async () => {
    const original = await buildDocx({ body: p(r("The fee is fixed for the first year.")) + p(r("It may rise afterwards.")) });
    const revised = await withNotes({ "1": "Excluding value added tax." }, p(r("The fee is fixed") + footnoteRef("1") + r(" for the first year.")) + p(r("It may rise afterwards.")));
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    expect(views(document).final).toBe("The fee is fixed for the first year.\nIt may rise afterwards.\n");
    expect(document.getView().footnotes).toHaveLength(1);
    expect(noteTexts(document, "final")).toEqual([" Excluding value added tax.\n"]);
    const first = document.getView().body.blocks[0] as ParagraphBlock;
    const reference = first.runs.find((run) => run.footnoteRef !== null);
    expect(reference?.revision?.kind).toBe("insert");
    expect(document.listRevisions().some((revision) => revision.storyId.startsWith("footnote:") && revision.kind === "insert")).toBe(true);
  });

  it("marks the reference of a footnote that the revised version dropped as deleted", async () => {
    const original = await withNotes({ "1": "Excluding value added tax.", "2": "By no more than five percent." }, body);
    const revised = await withNotes({ "1": "Excluding value added tax." }, p(r("The fee is fixed") + footnoteRef("1") + r(" for the first year.")) + p(r("It may rise afterwards.")));
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const second = document.getView().body.blocks[1] as ParagraphBlock;
    expect(second.runs.find((run) => run.footnoteRef !== null)?.revision?.kind).toBe("delete");
  });

  it("leaves the footnotes and header of the fixture alone when only the body changes", async () => {
    const source = await openDocx(loadFixture("footnotes-headers.docx"));
    const text = await source.package.getPartText("/word/document.xml");
    const sample = /<w:t(?: [^>]*)?>([A-Za-z][^<]{12,})<\/w:t>/.exec(text)?.[1];
    if (sample === undefined) throw new Error("fixture has no body text");
    source.package.setPart("/word/document.xml", text.replace(`>${sample}<`, `>${sample} Added words.<`));
    const document = await compareDocx(loadFixture("footnotes-headers.docx"), await source.package.save(), OPTIONS);
    expect(document.listRevisions().every((revision) => revision.storyId === "body")).toBe(true);
    expect(describeRevisions(document)).toContainEqual(["insert", "text", " Added words."]);
    const saved = await reopen(document);
    for (const name of ["/word/footnotes.xml", "/word/header1.xml", "/word/footer1.xml"]) {
      expect(await saved.package.getPartText(name)).toBe(await source.package.getPartText(name));
    }
  });
});

describe("endnotes", () => {
  it("compares an endnote both versions refer to and brings a new one over", async () => {
    const reference = (id: string): string => `<w:r><w:endnoteReference w:id="${id}"/></w:r>`;
    const note = (text: string): string => p(`<w:r><w:endnoteRef/></w:r>${r(` ${text}`)}`);
    const original = await buildDocx({
      body: p(r("Sources are listed") + reference("1") + r(" at the end.")) + p(r("A closing remark.")),
      endnotes: { "1": note("Annual report of 2026.") },
    });
    const revised = await buildDocx({
      body: p(r("Sources are listed") + reference("1") + r(" at the end.")) + p(r("A closing remark") + reference("2") + r(".")),
      endnotes: { "1": note("Annual report of 2027."), "2": note("Private correspondence.") },
    });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const texts = (view: "final" | "original"): string[] =>
      document.getView().endnotes.map((story) => document.getPlainText({ storyId: story.id, view }));
    expect(texts("final")).toEqual([" Annual report of 2027.\n", " Private correspondence.\n"]);
    expect(texts("original")[0]).toBe(" Annual report of 2026.\n");
    expect(describeRevisions(document)).toContainEqual(["delete", "text", "2026"]);
    expect(describeRevisions(document)).toContainEqual(["insert", "text", "2027"]);
    expect(views(document).final).toBe("Sources are listed at the end.\nA closing remark.\n");
  });
});

describe("headers", () => {
  it("compares the header of the same section and type", async () => {
    const original = await buildDocx({ body: p(r("Body text.")), header: p(r("Draft of 1 March")) });
    const revised = await buildDocx({ body: p(r("Body text.")), header: p(r("Draft of 9 March")) });
    const document = await reopen(await compareDocx(original, revised, OPTIONS));
    const header = document.getView().headers[0];
    if (header === undefined) throw new Error("no header");
    expect(document.getPlainText({ storyId: header.id, view: "final" })).toBe("Draft of 9 March\n");
    expect(document.getPlainText({ storyId: header.id, view: "original" })).toBe("Draft of 1 March\n");
    expect(document.listRevisions().every((revision) => revision.storyId === header.id)).toBe(true);
  });
});

describe("formatting-only changes", () => {
  it("records changed run formatting as a formatting revision and classifies it", async () => {
    const original = await buildDocx({ body: p(r("Payment is due in ") + r("thirty days") + r(" from invoice.")) });
    const revised = await buildDocx({ body: p(r("Payment is due in ") + r("thirty days", "<w:b/>") + r(" from invoice.")) });
    const { document, summary } = await compareDocxDetailed(original, revised, OPTIONS);
    expect(describeRevisions(document)).toEqual([["format", "runFormat", "thirty days"]]);
    const revision = document.listRevisions()[0];
    expect(revision?.formatChange).toEqual({ before: { bold: false }, after: { bold: true } });
    expect(summary).toMatchObject({ identical: false, total: 1, substantive: 0, formattingOnly: 1 });
    expect(summary.changes[0]).toMatchObject({ kind: "format", classification: "formatting", text: "thirty days" });
    expect(views(document).final).toBe(views(document).original);
    const saved = await reopen(document);
    const block = saved.getView().body.blocks[0] as ParagraphBlock;
    expect(block.runs.find((run) => run.text === "thirty days")?.bold).toBe(true);
  });

  it("finds a formatting change that covers part of a run and one next to a text change", async () => {
    const original = await buildDocx({ body: p(r("The Supplier shall deliver the report within ten days.")) });
    const revised = await buildDocx({
      body: p(r("The Supplier shall deliver the ") + r("report", "<w:i/>") + r(" within fifteen days.")),
    });
    const { document, summary } = await compareDocxDetailed(original, revised, OPTIONS);
    expect(describeRevisions(document)).toEqual([
      ["format", "runFormat", "report"],
      ["delete", "text", "ten"],
      ["insert", "text", "fifteen"],
    ]);
    expect(summary.changes.map((change) => change.classification)).toEqual(["formatting", "substantive", "substantive"]);
    expect(summary).toMatchObject({ substantive: 2, formattingOnly: 1 });
  });

  it("records changed paragraph properties", async () => {
    const original = await buildDocx({ body: p(r("Governing law: England and Wales.")) + p(r("Second.")) });
    const revised = await buildDocx({ body: p(r("Governing law: England and Wales."), `<w:jc w:val="center"/>`) + p(r("Second.")) });
    const { document, summary } = await compareDocxDetailed(original, revised, OPTIONS);
    expect(describeRevisions(document)).toEqual([["format", "paragraphFormat", "Governing law: England and Wales."]]);
    expect(document.listRevisions()[0]?.formatChange).toEqual({ before: { alignment: "left" }, after: { alignment: "center" } });
    expect(summary.changes[0]?.classification).toBe("formatting");
    const saved = await reopen(document);
    expect((saved.getView().body.blocks[0] as ParagraphBlock).style.alignment).toBe("center");
  });

  it("ignores formatting when asked to", async () => {
    const original = await buildDocx({ body: p(r("Payment is due in ") + r("thirty days") + r(" from invoice.")) });
    const revised = await buildDocx({ body: p(r("Payment is due in ") + r("thirty days", "<w:b/>") + r(" from invoice.")) });
    const { summary } = await compareDocxDetailed(original, revised, { ...OPTIONS, compareFormatting: false });
    expect(summary.identical).toBe(true);
  });
});

describe("self-check", () => {
  it("accepts a correct comparison and rejects a result whose text was tampered with", async () => {
    const original = await bodyOf("Alpha one two three.", "Beta four five six.");
    const revised = await bodyOf("Alpha one two three.", "Beta four seven six.");
    const { document, check } = await compareDocxDetailed(original, revised, OPTIONS);
    expect(() => verifyComparison(getDocxIndex(document), check)).not.toThrow();
    const index = getDocxIndex(document);
    const inserted = index.revisions.groups.find((group) => group.revision.kind === "insert")?.members[0]?.element;
    if (inserted === undefined) throw new Error("no insertion");
    const parent = inserted.parent;
    remove(inserted);
    if (parent === null || parent.kind !== "element") throw new Error("detached");
    index.markDirty(parent);
    let thrown: unknown = null;
    try {
      verifyComparison(index, check);
    } catch (error) {
      thrown = error;
    }
    expect(isOfficeError(thrown, "invalid_operation")).toBe(true);
    expect((thrown as { details: Record<string, unknown> }).details).toMatchObject({ check: COMPARE_SELF_CHECK, view: "final", story: "body" });
  });

  it("refuses arguments that are not documents", async () => {
    const original = await bodyOf("Alpha.");
    await expect(compareDocx(original, new Uint8Array([1, 2, 3]), OPTIONS)).rejects.toSatisfy((error) => isOfficeError(error, "not_a_zip"));
    await expect(compareDocx(original, original, { author: "", date: "2027-02-01T10:00:00Z" })).rejects.toSatisfy((error) =>
      isOfficeError(error, "invalid_argument"),
    );
    await expect(compareDocx(original, original, { author: "A", date: "yesterday" })).rejects.toSatisfy((error) =>
      isOfficeError(error, "invalid_argument"),
    );
  });
});
