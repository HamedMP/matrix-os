import { describe, expect, it } from "vitest";

import type { DocxDocument, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { compareDocx, compareDocxDetailed, openDocx } from "../../../../packages/office/src/docx/index.js";
import {
  AUTHOR,
  DATE,
  OPTIONS,
  bodyOf,
  buildDocx,
  describeRevisions,
  loadFixture,
  p,
  r,
  reopen,
  resolvedText,
  textOf,
  textTable,
  views,
} from "./helpers.js";

/** Accepting everything in the written file gives the revised body and rejecting everything the original, by an independent reading of the XML. */
async function expectResolves(document: DocxDocument, original: Uint8Array, revised: Uint8Array): Promise<void> {
  const written = await document.save();
  expect(await resolvedText(written, "accept")).toBe(await resolvedText(revised, "accept"));
  expect(await resolvedText(written, "reject")).toBe(await resolvedText(original, "accept"));
}

/** Compares, checks both views against the inputs (also after a save), and returns the result. */
async function compared(original: Uint8Array, revised: Uint8Array): Promise<DocxDocument> {
  const document = await compareDocx(original, revised, OPTIONS);
  const expected = { final: await textOf(revised), original: await textOf(original) };
  expect({ final: views(document).final, original: views(document).original }).toEqual(expected);
  const saved = await reopen(document);
  expect({ final: views(saved).final, original: views(saved).original }).toEqual(expected);
  for (const revision of saved.listRevisions()) {
    expect([revision.author, revision.date]).toEqual([AUTHOR, DATE]);
  }
  await expectResolves(document, original, revised);
  return document;
}

describe("identical documents", () => {
  const fixtures = ["basic.docx", "contract.docx", "table.docx", "footnotes-headers.docx", "numbering.docx", "links-fields.docx", "unicode.docx", "comments.docx"];
  it.each(fixtures)("%s compared with itself has no revisions and keeps every part byte for byte", async (name) => {
    const bytes = loadFixture(name);
    const { document, summary } = await compareDocxDetailed(bytes, bytes, OPTIONS);
    expect(document.listRevisions()).toEqual([]);
    expect(summary).toMatchObject({ identical: true, total: 0, substantive: 0, formattingOnly: 0 });
    expect(summary.counts).toEqual({ insert: 0, delete: 0, moveFrom: 0, moveTo: 0, format: 0 });
    const source = await openDocx(bytes);
    const saved = await reopen(document);
    for (const part of source.package.listParts()) {
      const [written, read] = [await saved.package.getPartBytes(part.name), await source.package.getPartBytes(part.name)];
      expect(Buffer.from(written).equals(Buffer.from(read)), part.name).toBe(true);
    }
  });

  it("treats revisions pending in the inputs as accepted", async () => {
    const tracked = loadFixture("tracked.docx");
    const accepted = (await openDocx(tracked)).getPlainText({ view: "final" });
    const { document, summary } = await compareDocxDetailed(tracked, tracked, OPTIONS);
    expect(summary.identical).toBe(true);
    expect(document.listRevisions()).toEqual([]);
    expect(views(document)).toEqual({ final: accepted, original: accepted, markup: accepted });
  });

  it("compares a document that has pending revisions by its accepted text", async () => {
    const tracked = loadFixture("tracked.docx");
    const base = await bodyOf("Tracked Changes Sample", "The supplier shall deliver the report within ten business days.", "End of sample.");
    const document = await compareDocx(base, tracked, OPTIONS);
    const accepted = (await openDocx(tracked)).getPlainText({ view: "final" });
    expect(views(document).final).toBe(accepted);
    expect(views(document).original).toBe(await textOf(base));
    expect(document.listRevisions().every((revision) => revision.author === AUTHOR)).toBe(true);
    await expectResolves(document, base, await (await compareDocx(tracked, tracked, OPTIONS)).save());
  });
});

describe("paragraphs", () => {
  it("inserts a paragraph in the middle, at the start and at the end", async () => {
    const original = await bodyOf("Alpha one two three.", "Beta four five six.", "Gamma seven eight nine.");
    for (const revised of [
      await bodyOf("Alpha one two three.", "A wholly new paragraph here.", "Beta four five six.", "Gamma seven eight nine."),
      await bodyOf("A wholly new paragraph here.", "Alpha one two three.", "Beta four five six.", "Gamma seven eight nine."),
      await bodyOf("Alpha one two three.", "Beta four five six.", "Gamma seven eight nine.", "A wholly new paragraph here."),
    ]) {
      const document = await compared(original, revised);
      expect(describeRevisions(document).map(([kind]) => kind)).toEqual(["insert"]);
      expect(document.listRevisions()[0]?.text.replace(/\n/g, "")).toBe("A wholly new paragraph here.");
    }
  });

  it("deletes a paragraph in the middle, at the start and at the end", async () => {
    const original = await bodyOf("Alpha one two three.", "Beta four five six.", "Gamma seven eight nine.");
    for (const revised of [
      await bodyOf("Alpha one two three.", "Gamma seven eight nine."),
      await bodyOf("Beta four five six.", "Gamma seven eight nine."),
      await bodyOf("Alpha one two three.", "Beta four five six."),
    ]) {
      const document = await compared(original, revised);
      expect(describeRevisions(document).map(([kind]) => kind)).toEqual(["delete"]);
    }
  });

  it("replaces unrelated trailing paragraphs without leaving an empty paragraph in either view", async () => {
    const original = await bodyOf("Alpha one two three.", "Old closing words entirely.", "Second old ending line.");
    const revised = await bodyOf("Alpha one two three.", "Fresh different final sentence!");
    const document = await compared(original, revised);
    expect(new Set(describeRevisions(document).map(([kind]) => kind))).toEqual(new Set(["insert", "delete"]));
  });

  it("represents a split paragraph and a merged paragraph with paragraph mark revisions", async () => {
    const whole = await bodyOf("Intro stays.", "The first sentence is here. The second sentence follows it.", "Outro stays.");
    const parts = await bodyOf("Intro stays.", "The first sentence is here.", "The second sentence follows it.", "Outro stays.");
    const split = await compared(whole, parts);
    expect(split.getView().body.blocks).toHaveLength(4);
    expect(split.listRevisions().every((revision) => revision.kind === "insert" || revision.kind === "delete")).toBe(true);
    expect(split.listRevisions().some((revision) => revision.kind === "insert" && revision.text.includes("\n"))).toBe(true);
    const merged = await compared(parts, whole);
    expect(merged.getView().body.blocks).toHaveLength(4);
    expect(merged.listRevisions().some((revision) => revision.kind === "delete" && revision.text.includes("\n"))).toBe(true);
  });

  it("reports a relocated paragraph as a move and an edited one as a move with word changes", async () => {
    const original = await bodyOf(
      "First clause about payment terms and invoices.",
      "Second clause about confidentiality and secrets.",
      "Third clause about liability and insurance cover.",
      "Fourth clause about governing law and courts.",
    );
    const moved = await bodyOf(
      "Second clause about confidentiality and secrets.",
      "Third clause about liability and insurance cover.",
      "Fourth clause about governing law and courts.",
      "First clause about payment terms and invoices.",
    );
    const document = await compared(original, moved);
    expect(describeRevisions(document)).toEqual([
      ["moveFrom", "text", "First clause about payment terms and invoices.\n"],
      // At the end of the body the moved text takes the paragraph mark in front of it.
      ["moveTo", "text", "\nFirst clause about payment terms and invoices."],
    ]);
    const [from, to] = document.listRevisions();
    expect(from?.pairedWith).toBe(to?.id);

    const edited = await bodyOf(
      "Second clause about confidentiality and secrets.",
      "Third clause about liability and insurance cover.",
      "Fourth clause about governing law and courts.",
      "First clause about payment terms and monthly invoices.",
    );
    const second = await compared(original, edited);
    const kinds = describeRevisions(second).map(([kind]) => kind);
    expect(kinds).toContain("moveFrom");
    expect(kinds).toContain("moveTo");
    expect(describeRevisions(second)).toContainEqual(["insert", "text", "monthly "]);
  });

  it("keeps the runs and formatting of unchanged text", async () => {
    const original = await buildDocx({ body: p(r("Payment is due in ") + r("thirty", "<w:b/>") + r(" days from invoice.")) });
    const revised = await buildDocx({ body: p(r("Payment is due in ") + r("thirty", "<w:b/>") + r(" days from the invoice date.")) });
    const document = await compared(original, revised);
    const block = document.getView().body.blocks[0];
    if (block?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(block.runs.find((run) => run.text === "thirty")?.bold).toBe(true);
    expect(block.runs.filter((run) => run.revision !== null).every((run) => !run.bold)).toBe(true);
    expect(document.listRevisions().every((revision) => revision.kind !== "format")).toBe(true);
  });
});

describe("tables", () => {
  const before = (): Promise<Uint8Array> =>
    buildDocx({
      body: p(r("Price list")) + textTable(["Item", "Price"], ["Widget", "10 pounds"], ["Gadget", "25 pounds"]) + p(r("End of list")),
    });

  it("keeps a changed cell inside its cell, word by word", async () => {
    const revised = await buildDocx({
      body: p(r("Price list")) + textTable(["Item", "Price"], ["Widget", "12 pounds"], ["Gadget", "25 pounds"]) + p(r("End of list")),
    });
    const document = await compared(await before(), revised);
    expect(describeRevisions(document)).toEqual([
      ["delete", "text", "10"],
      ["insert", "text", "12"],
    ]);
    const table = document.getView().body.blocks[1] as TableBlock;
    expect(table.rows).toHaveLength(3);
    expect(table.rows.every((tableRow) => tableRow.revision === null)).toBe(true);
    expect(document.listRevisions()[0]?.blockIds).toEqual([table.rows[1]?.cells[1]?.blocks[0]?.id]);
  });

  it("marks an inserted row and a deleted row on the row", async () => {
    const inserted = await buildDocx({
      body:
        p(r("Price list")) +
        textTable(["Item", "Price"], ["Widget", "10 pounds"], ["Sprocket", "7 pounds"], ["Gadget", "25 pounds"]) +
        p(r("End of list")),
    });
    const withRow = await compared(await before(), inserted);
    expect(describeRevisions(withRow)).toEqual([["insert", "tableRow", "Sprocket\t7 pounds"]]);
    const table = withRow.getView().body.blocks[1] as TableBlock;
    expect(table.rows.map((tableRow) => tableRow.revision?.kind ?? null)).toEqual([null, null, "insert", null]);

    const removed = await buildDocx({
      body: p(r("Price list")) + textTable(["Item", "Price"], ["Gadget", "25 pounds"]) + p(r("End of list")),
    });
    const withoutRow = await compared(await before(), removed);
    expect(describeRevisions(withoutRow)).toEqual([["delete", "tableRow", "Widget\t10 pounds"]]);
    const { summary } = await compareDocxDetailed(await before(), removed, OPTIONS);
    expect(summary.tableRows).toEqual({ inserted: 0, deleted: 1 });
  });

  it("inserts and deletes a whole table", async () => {
    const without = await buildDocx({ body: p(r("Price list")) + p(r("End of list")) });
    const added = await compared(without, await before());
    expect(new Set(describeRevisions(added).map(([kind, scope]) => `${kind}:${scope}`))).toEqual(new Set(["insert:tableRow"]));
    const removed = await compared(await before(), without);
    expect(new Set(describeRevisions(removed).map(([kind, scope]) => `${kind}:${scope}`))).toEqual(new Set(["delete:tableRow"]));
  });

  it("compares the paragraphs of a cell with each other", async () => {
    const one = await buildDocx({
      body: p(r("Head")) + `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr/>${p(r("First line of the cell."))}${p(r("Second line of the cell."))}</w:tc></w:tr></w:tbl>` + p(r("Tail")),
    });
    const two = await buildDocx({
      body: p(r("Head")) + `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr/>${p(r("First line of the cell."))}</w:tc></w:tr></w:tbl>` + p(r("Tail")),
    });
    const shorter = await compared(one, two);
    expect(describeRevisions(shorter).map(([kind]) => kind)).toEqual(["delete"]);
    const longer = await compared(two, one);
    expect(describeRevisions(longer).map(([kind]) => kind)).toEqual(["insert"]);
  });

  it("handles the fixture table against an edited copy of itself", async () => {
    const source = await openDocx(loadFixture("table.docx"));
    const text = await source.package.getPartText("/word/document.xml");
    const firstCellText = /<w:tc>.*?<w:t(?: [^>]*)?>([^<]+)<\/w:t>/s.exec(text)?.[1];
    if (firstCellText === undefined) throw new Error("fixture has no cell text");
    source.package.setPart("/word/document.xml", text.replace(`>${firstCellText}<`, `>${firstCellText} (revised)<`));
    const edited = await source.package.save();
    const document = await compared(loadFixture("table.docx"), edited);
    expect(describeRevisions(document)).toContainEqual(["insert", "text", " (revised)"]);
  });
});
