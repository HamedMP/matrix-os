import { describe, expect, it } from "vitest";

import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { cell, p, r, row, tbl } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, bodyXml, build, paragraphs, reopen, text } from "./helpers.js";

const LINK =
  '<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the terms</w:t></w:r></w:hyperlink>';
const FIELD =
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>23 November</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
const INS = (author: string, content: string, id = "900"): string =>
  `<w:ins w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z">${content}</w:ins>`;
const DEL = (author: string, textValue: string, id = "901"): string =>
  `<w:del w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${textValue}</w:delText></w:r></w:del>`;

function make(body: string): { doc: DocxDocument; ids: string[] } {
  const doc = build({ body, links: { rIdLink: "https://example.com/terms" } });
  return { doc, ids: paragraphs(doc).map((block) => block.id) };
}

const range = (a: string, from: number, b: string, to: number) => ({
  start: { blockId: a, offset: from },
  end: { blockId: b, offset: to },
});

describe("deleteRange, direct", () => {
  it("removes text across runs and a tab, and the runs that are left empty", () => {
    const { doc, ids } = make(p(r("one ") + r("two", "<w:b/>") + "<w:r><w:tab/><w:t>three</w:t></w:r>" + r(" four")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "deleteRange", range: range(id, 2, id, 10) }], DIRECT);
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:t xml:space="preserve">on</w:t></w:r><w:r><w:t xml:space="preserve">ree</w:t></w:r><w:r><w:t xml:space="preserve"> four</w:t></w:r></w:p>',
    );
    expect(text(doc)).toBe("onree four\n");
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 2 });
    expect(doc.listRevisions()).toEqual([]);
  });

  it("removes a link whose whole text goes, and a field whose whole result goes", () => {
    const { doc, ids } = make(p(r("See ") + LINK + r(" dated ") + FIELD + r(".")));
    const id = ids[0] as string;
    const block = doc.getBlock(id);
    if (block?.type !== "paragraph") throw new Error("not a paragraph");
    const fieldStart = block.text.indexOf("23 November");
    doc.applyOps(
      [
        { type: "deleteRange", range: range(id, fieldStart, id, fieldStart + 11) },
        { type: "deleteRange", range: range(id, 4, id, 13) },
      ],
      DIRECT,
    );
    const xml = blockXml(doc, id);
    expect(xml).not.toContain("w:hyperlink");
    expect(xml).not.toContain("w:fldChar");
    expect(xml).not.toContain("w:instrText");
    expect(text(doc)).toBe("See  dated .\n");
  });

  it("keeps a field whose result is only partly deleted", () => {
    const { doc, ids } = make(p(r("On ") + FIELD + r(".")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "deleteRange", range: range(id, 3, id, 6) }], DIRECT);
    expect(blockXml(doc, id).match(/w:fldChar /g)).toHaveLength(3);
    expect(text(doc)).toBe("On November.\n");
  });

  it("merges the paragraphs of a range across marks; the first keeps its id and properties", () => {
    const { doc, ids } = make(
      p(r("First paragraph"), '<w:jc w:val="center"/>') + p(r("Second")) + tbl(row(cell(p(r("cell"))))) + p(r("Fourth paragraph"), '<w:jc w:val="right"/>'),
    );
    const [first, second, fourth] = ids as [string, string, string];
    const result = doc.applyOps(
      [{ type: "deleteRange", range: range(first, 5, fourth, 7) }],
      { ...DIRECT, positions: [{ blockId: second, offset: 3 }, { blockId: fourth, offset: 10 }, { blockId: first, offset: 2 }] },
    );
    expect(bodyXml(doc)).toEqual([
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">First</w:t></w:r><w:r><w:t xml:space="preserve">paragraph</w:t></w:r></w:p>',
    ]);
    expect(result.removedBlockIds).toHaveLength(4);
    expect(result.removedBlockIds).toContain(second);
    expect(result.removedBlockIds).toContain(fourth);
    expect(result.changedBlockIds).toEqual([first]);
    expect(result.positions).toEqual([
      { blockId: first, offset: 5 },
      { blockId: first, offset: 8 },
      { blockId: first, offset: 2 },
    ]);
  });

  it("removes text from inside pending revisions with its share of the revision", () => {
    const { doc, ids } = make(p(r("a") + INS("Alex Morgan", r("NEW")) + DEL("Alex Morgan", "OLD") + r("z")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "deleteRange", range: range(id, 2, id, 6) }], DIRECT);
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["insert", "N"],
      ["delete", "D"],
    ]);
    doc.applyOps([{ type: "deleteRange", range: range(id, 0, id, 4) }], DIRECT);
    expect(doc.listRevisions()).toEqual([]);
    expect(blockXml(doc, id)).toMatch(/^<w:p(\/>|><\/w:p>)$/);
  });

  it("does nothing for an empty range and rejects ranges that are not siblings or out of order", () => {
    const { doc, ids } = make(p(r("outside")) + tbl(row(cell(p(r("inside"))))) + p(r("after")));
    const [outside, after] = ids as [string, string];
    const table = doc.getView().body.blocks[1];
    if (table?.type !== "table") throw new Error("no table");
    const inside = table.rows[0]?.cells[0]?.blocks[0]?.id as string;
    const before = bodyXml(doc);
    doc.applyOps([{ type: "deleteRange", range: range(outside, 3, outside, 3) }], DIRECT);
    expect(bodyXml(doc)).toEqual(before);
    const code = (op: unknown): string => {
      try {
        doc.applyOps([op as never], DIRECT);
      } catch (error) {
        return isOfficeError(error) ? error.code : "other";
      }
      return "no error";
    };
    expect(code({ type: "deleteRange", range: range(outside, 1, inside, 2) })).toBe("invalid_operation");
    expect(code({ type: "deleteRange", range: range(after, 1, outside, 2) })).toBe("invalid_argument");
    expect(code({ type: "deleteRange", range: range(outside, 4, outside, 2) })).toBe("invalid_argument");
    expect(code({ type: "deleteRange", range: range(outside, 0, outside, 99) })).toBe("stale_reference");
    expect(code({ type: "deleteRange", range: range(table.id, 0, table.id, 1) })).toBe("invalid_operation");
    expect(bodyXml(doc)).toEqual(before);
  });
});

describe("deleteRange, tracked", () => {
  it("keeps the text as w:delText inside w:del", () => {
    const { doc, ids } = make(p(r("one ") + r("two", "<w:b/>") + "<w:r><w:tab/><w:t>three</w:t></w:r>" + r(" four")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "deleteRange", range: range(id, 2, id, 10) }], TRACKED);
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:t xml:space="preserve">on</w:t></w:r>' +
        `<w:del w:id="1" w:author="${RAE}" w:date="${DATE}">` +
        '<w:r><w:delText xml:space="preserve">e </w:delText></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:delText xml:space="preserve">two</w:delText></w:r>' +
        '<w:r><w:tab/><w:delText xml:space="preserve">th</w:delText></w:r></w:del>' +
        '<w:r><w:t xml:space="preserve">ree</w:t></w:r><w:r><w:t xml:space="preserve"> four</w:t></w:r></w:p>',
    );
    expect(text(doc, "final")).toBe("onree four\n");
    expect(text(doc, "original")).toBe("one two\tthree four\n");
    const revisions = doc.listRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ kind: "delete", author: RAE, date: DATE, text: "e two\tth", blockIds: [id] });
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 2 });
  });

  it("removes its own pending insertion outright and leaves earlier deletions alone", () => {
    const { doc, ids } = make(p(r("a") + INS(RAE, r("MINE")) + DEL("Alex Morgan", "GONE") + r("z")));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [{ type: "deleteRange", range: range(id, 0, id, 10) }],
      { ...TRACKED, positions: [{ blockId: id, offset: 3 }, { blockId: id, offset: 9 }] },
    );
    const xml = blockXml(doc, id);
    expect(xml).not.toContain("MINE");
    expect(xml).not.toContain("w:ins");
    expect(xml).toContain('<w:del w:id="901" w:author="Alex Morgan"');
    expect(text(doc, "final")).toBe("\n");
    expect(text(doc, "original")).toBe("aGONEz\n");
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.author, revision.text])).toEqual([
      ["delete", RAE, "a"],
      ["delete", "Alex Morgan", "GONE"],
      ["delete", RAE, "z"],
    ]);
    // The four removed characters are gone from the markup; positions behind them move up.
    expect(result.positions).toEqual([{ blockId: id, offset: 1 }, { blockId: id, offset: 5 }]);
  });

  it("nests a deletion inside the insertion of another author", () => {
    const { doc, ids } = make(p(r("a") + INS("Alex Morgan", r("THEIRS")) + r("z")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "deleteRange", range: range(id, 3, id, 5) }], TRACKED);
    expect(blockXml(doc, id)).toMatch(
      /<w:ins w:id="900" w:author="Alex Morgan"[^>]*><w:r><w:t xml:space="preserve">TH<\/w:t><\/w:r><w:del w:id="\d+" w:author="Rae Okafor"[^>]*><w:r><w:delText xml:space="preserve">EI<\/w:delText><\/w:r><\/w:del><w:r><w:t xml:space="preserve">RS<\/w:t><\/w:r><\/w:ins>/,
    );
    expect(text(doc, "final")).toBe("aTHRSz\n");
    expect(text(doc, "original")).toBe("az\n");
  });

  it("deletes inside a link and the code of a field that goes as a whole", async () => {
    const { doc, ids } = make(p(r("See ") + LINK + r(" dated ") + FIELD + r(".")));
    const id = ids[0] as string;
    const block = doc.getBlock(id);
    if (block?.type !== "paragraph") throw new Error("not a paragraph");
    const fieldStart = block.text.indexOf("23 November");
    doc.applyOps(
      [
        { type: "deleteRange", range: range(id, fieldStart, id, fieldStart + 11) },
        { type: "deleteRange", range: range(id, 8, id, 13) },
      ],
      TRACKED,
    );
    const xml = blockXml(doc, id);
    expect(xml).toMatch(/<w:hyperlink r:id="rIdLink"><w:r>.*?the <\/w:t><\/w:r><w:del [^>]*><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:delText[^>]*>terms<\/w:delText><\/w:r><\/w:del><\/w:hyperlink>/);
    expect(xml).toMatch(/<w:del [^>]*><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:delInstrText xml:space="preserve"> DATE <\/w:delInstrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:delText>23 November<\/w:delText><\/w:r><w:r><w:fldChar w:fldCharType="end"\/><\/w:r><\/w:del>/);
    expect(text(doc, "final")).toBe("See the  dated .\n");
    expect(text(doc, "original")).toBe("See the terms dated 23 November.\n");
    const rejected = await reopen(doc);
    rejected.rejectRevisions("all");
    expect(blockXml(rejected, paragraphs(rejected)[0]?.id as string)).toContain('<w:instrText xml:space="preserve"> DATE </w:instrText>');
    expect(text(rejected, "markup")).toBe("See the terms dated 23 November.\n");
    const accepted = await reopen(doc);
    accepted.acceptRevisions("all");
    expect(blockXml(accepted, paragraphs(accepted)[0]?.id as string)).not.toContain("fldChar");
  });

  it("marks the paragraph marks between the ends as deleted, and the rows of a table in between", () => {
    const { doc, ids } = make(p(r("First paragraph")) + p(r("Second")) + tbl(row(cell(p(r("cell"))))) + p(r("Fourth paragraph")));
    const [first, second, fourth] = ids as [string, string, string];
    const result = doc.applyOps([{ type: "deleteRange", range: range(first, 5, fourth, 7) }], TRACKED);
    const xml = bodyXml(doc);
    const mark = `<w:pPr><w:rPr><w:del w:id="\\d+" w:author="${RAE}" w:date="${DATE}"/></w:rPr></w:pPr>`;
    expect(xml[0]).toMatch(new RegExp(`^<w:p>${mark}<w:r><w:t xml:space="preserve">First</w:t></w:r><w:del `));
    expect(xml[1]).toMatch(new RegExp(`^<w:p>${mark}<w:del [^>]*><w:r><w:delText[^>]*>Second</w:delText></w:r></w:del></w:p>$`));
    expect(xml[2]).toMatch(/<w:tr><w:trPr><w:del [^>]*\/><\/w:trPr><w:tc><w:p><w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText[^>]*>cell<\/w:delText>/);
    expect(xml[3]).toMatch(/^<w:p><w:del [^>]*><w:r><w:delText xml:space="preserve">Fourth <\/w:delText><\/w:r><\/w:del><w:r><w:t xml:space="preserve">paragraph<\/w:t><\/w:r><\/w:p>$/);
    expect(result.removedBlockIds).toEqual([]);
    expect(result.changedBlockIds).toContain(first);
    expect(result.changedBlockIds).toContain(second);
    expect(result.changedBlockIds).toContain(fourth);
    expect(text(doc, "original")).toBe("First paragraph\nSecond\ncell\nFourth paragraph\n");
    const accepted = doc.snapshot();
    doc.acceptRevisions("all");
    expect(bodyXml(doc)).toEqual([
      '<w:p><w:r><w:t xml:space="preserve">First</w:t></w:r><w:r><w:t xml:space="preserve">paragraph</w:t></w:r></w:p>',
    ]);
    doc.restore(accepted);
    doc.rejectRevisions("all");
    expect(text(doc, "markup")).toBe("First paragraph\nSecond\ncell\nFourth paragraph\n");
    expect(bodyXml(doc).join("")).not.toMatch(/w:del|w:trPr|w:pPr/);
  });

  it("takes back a paragraph break of the same author instead of marking it deleted", () => {
    const { doc, ids } = make(p(r("abcdef")));
    const id = ids[0] as string;
    const split = doc.applyOps([{ type: "splitParagraph", at: { blockId: id, offset: 3 } }], TRACKED);
    const created = split.createdBlockIds[0] as string;
    expect(text(doc, "final")).toBe("abc\ndef\n");
    const result = doc.applyOps([{ type: "deleteRange", range: range(id, 2, created, 1) }], TRACKED);
    expect(result.removedBlockIds).toEqual([created]);
    expect(text(doc, "final")).toBe("abef\n");
    expect(text(doc, "original")).toBe("abcdef\n");
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["delete", "cd"]]);
    expect(blockXml(doc, id)).not.toContain("w:pPr");
  });
});
