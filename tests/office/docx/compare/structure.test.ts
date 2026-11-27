import { describe, expect, it } from "vitest";

import type { TableBlock } from "../../../../packages/office/src/api/docx.js";
import { compareDocx, compareDocxDetailed, openDocx } from "../../../../packages/office/src/docx/index.js";
import {
  AUTHOR,
  OPTIONS,
  bodyOf,
  buildDocx,
  compared,
  describeRevisions,
  expectResolves,
  loadFixture,
  p,
  r,
  reopen,
  textOf,
  textTable,
  views,
} from "./helpers.js";

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

describe("tracked cells pending in the inputs", () => {
  const who = 'w:author="Alex Morgan" w:date="2026-01-05T09:30:00Z"';
  const tc = (text: string, mark = ""): string => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${mark}</w:tcPr>${p(r(text))}</w:tc>`;
  const pending = (): Promise<Uint8Array> =>
    buildDocx({
      body:
        `<w:tbl><w:tblPr/><w:tblGrid/>` +
        `<w:tr>${tc("Item")}${tc("Price", `<w:cellDel w:id="1" ${who}/>`)}${tc("Qty", `<w:cellIns w:id="2" ${who}/>`)}</w:tr>` +
        `<w:tr>${tc("Widget")}${tc("9.99", `<w:cellDel w:id="3" ${who}/>`)}${tc("4", `<w:cellIns w:id="4" ${who}/>`)}</w:tr>` +
        `<w:tr>${tc("gone", `<w:cellDel w:id="5" ${who}/>`)}${tc("gone too", `<w:cellDel w:id="6" ${who}/>`)}</w:tr>` +
        `</w:tbl>${p(r("end"))}`,
    });

  it("compares a deleted column, an inserted column and an emptied row by what accepting them leaves", async () => {
    const tracked = await pending();
    const accepted = "Item\tQty\nWidget\t4\nend\n";
    expect((await openDocx(tracked)).getPlainText({ view: "final" })).toBe(accepted);
    const same = await compareDocxDetailed(tracked, tracked, OPTIONS);
    expect(same.summary.identical).toBe(true);
    expect(views(same.document)).toEqual({ final: accepted, original: accepted, markup: accepted });

    const clean = await buildDocx({ body: textTable(["Item", "Qty"], ["Widget", "4"]) + p(r("end")) });
    expect((await compareDocxDetailed(clean, tracked, OPTIONS)).document.listRevisions()).toEqual([]);
    const changed = await buildDocx({ body: textTable(["Item", "Qty"], ["Widget", "5"]) + p(r("end")) });
    const document = await compareDocx(tracked, changed, OPTIONS);
    expect(views(document)).toMatchObject({ original: accepted, final: "Item\tQty\nWidget\t5\nend\n" });
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

describe("a paragraph break deleted in an input", () => {
  const deletedMark = `<w:rPr><w:del w:id="91" w:author="${AUTHOR}" w:date="2027-01-01T00:00:00Z"/></w:rPr>`;
  const alignments = (document: Awaited<ReturnType<typeof openDocx>>): string[] =>
    document.getView().body.blocks.flatMap((block) => (block.type === "paragraph" ? [block.style.alignment] : []));

  it("joins the two paragraphs with the formatting that accepting the deletion keeps", async () => {
    const tracked = await buildDocx({
      body: p(r("Centered opening"), `<w:jc w:val="center"/>${deletedMark}`) + p(r(" and its right-aligned end"), `<w:jc w:val="right"/>`),
    });
    const accepted = await openDocx(tracked);
    accepted.acceptRevisions("all");
    expect(alignments(accepted)).toEqual(["center"]);
    const { document, summary } = await compareDocxDetailed(tracked, tracked, OPTIONS);
    expect(summary.identical).toBe(true);
    expect(alignments(document)).toEqual(alignments(accepted));
  });

  it("keeps the formatting of the following paragraph when the deleted one held no text", async () => {
    const tracked = await buildDocx({
      body: p("", `<w:jc w:val="center"/>${deletedMark}`) + p(r("Right-aligned text"), `<w:jc w:val="right"/>`),
    });
    const accepted = await openDocx(tracked);
    accepted.acceptRevisions("all");
    const { document } = await compareDocxDetailed(tracked, tracked, OPTIONS);
    expect(alignments(document)).toEqual(alignments(accepted));
    expect(alignments(document)).toEqual(["right"]);
  });
});
