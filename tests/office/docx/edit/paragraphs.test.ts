import { describe, expect, it } from "vitest";

import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { cell, p, r, row, tbl } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, bodyXml, build, paragraphs, text } from "./helpers.js";

const STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Clause"><w:name w:val="Clause"/><w:basedOn w:val="Normal"/></w:style>';
const SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
const MARK = (name: string): RegExp => new RegExp(`<w:pPr>.*<w:rPr><w:${name} w:id="\\d+" w:author="${RAE}" w:date="${DATE}"/></w:rPr></w:pPr>`);

function make(body: string): { doc: DocxDocument; ids: string[] } {
  const doc = build({ body, styles: STYLES });
  return { doc, ids: paragraphs(doc).map((block) => block.id) };
}

describe("insertParagraphAfter and insertParagraphBefore", () => {
  it("inserts a paragraph with the properties of its neighbour, directly", () => {
    const { doc, ids } = make(p(r("Clause one", "<w:i/>"), '<w:pStyle w:val="Clause"/><w:ind w:left="720"/>') + p(r("Last")));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [
        { type: "insertParagraphAfter", blockId: id, text: "Clause two" },
        { type: "insertParagraphBefore", blockId: id },
      ],
      DIRECT,
    );
    const xml = bodyXml(doc);
    expect(xml).toHaveLength(4);
    expect(xml[0]).toBe('<w:p><w:pPr><w:pStyle w:val="Clause"/><w:ind w:left="720"/></w:pPr></w:p>');
    expect(xml[2]).toBe(
      '<w:p><w:pPr><w:pStyle w:val="Clause"/><w:ind w:left="720"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>Clause two</w:t></w:r></w:p>',
    );
    expect(result.createdBlockIds).toEqual([paragraphs(doc)[0]?.id, paragraphs(doc)[2]?.id]);
    expect(result.results[0]?.createdBlockIds).toEqual([paragraphs(doc)[2]?.id]);
    expect(result.results[0]?.caret).toEqual({ blockId: paragraphs(doc)[2]?.id, offset: 0 });
    expect(result.changedBlockIds).toEqual([]);
    expect(text(doc)).toBe("\nClause one\nClause two\nLast\n");
  });

  it("applies the given style on top of the copied properties", () => {
    const { doc, ids } = make(p(r("Clause one"), '<w:pStyle w:val="Clause"/>'));
    doc.applyOps(
      [{ type: "insertParagraphAfter", blockId: ids[0] as string, text: "Centred", style: { alignment: "center", spacingAfterPt: 12 } }],
      DIRECT,
    );
    const created = paragraphs(doc)[1];
    expect(created?.style).toMatchObject({ styleId: "Clause", alignment: "center", spacingAfterPt: 12 });
  });

  it("records an inserted paragraph: the mark of the paragraph before it is the new one", () => {
    const { doc, ids } = make(p(r("Clause one")) + p(r("Last")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "insertParagraphAfter", blockId: id, text: "Clause two" }], TRACKED);
    const xml = bodyXml(doc);
    expect(xml[0]).toMatch(MARK("ins"));
    expect(xml[1]).toMatch(/^<w:p><w:ins [^>]*><w:r><w:t>Clause two<\/w:t><\/w:r><\/w:ins><\/w:p>$/);
    expect(text(doc, "final")).toBe("Clause one\nClause two\nLast\n");
    expect(text(doc, "original")).toBe("Clause one\nLast\n");
    const revisions = doc.listRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ kind: "insert", text: "\nClause two", author: RAE });
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(result.changedBlockIds).toEqual([id]);
    const snapshot = doc.snapshot();
    doc.rejectRevisions("all");
    expect(bodyXml(doc)).toHaveLength(2);
    expect(paragraphs(doc)[0]?.id).toBe(id);
    doc.restore(snapshot);
    doc.acceptRevisions("all");
    expect(text(doc, "markup")).toBe("Clause one\nClause two\nLast\n");
    expect(bodyXml(doc).join("")).not.toContain("w:ins");
  });

  it("marks the new paragraph itself when it goes before a block, after a table or after a section break", () => {
    const { doc, ids } = make(p(r("One"), SECT) + tbl(row(cell(p(r("cell"))))) + p(r("Two")));
    const [one, two] = ids as [string, string];
    const table = doc.getView().body.blocks.find((block) => block.type === "table")?.id as string;
    doc.applyOps(
      [
        { type: "insertParagraphBefore", blockId: two, text: "before two" },
        { type: "insertParagraphAfter", blockId: table, text: "after table" },
        { type: "insertParagraphAfter", blockId: one, text: "after break" },
        { type: "insertParagraphBefore", blockId: table, text: "before table" },
      ],
      TRACKED,
    );
    expect(text(doc, "final")).toBe("One\nafter break\nbefore table\ncell\nafter table\nbefore two\nTwo\n");
    expect(blockXml(doc, one)).toContain("<w:sectPr>");
    expect(blockXml(doc, one)).not.toContain("w:ins");
    for (const block of paragraphs(doc).filter((entry) => entry.text.includes(" "))) {
      expect(blockXml(doc, block.id)).toMatch(MARK("ins"));
      expect(block.markRevision?.kind).toBe("insert");
    }
    doc.rejectRevisions("all");
    expect(text(doc, "markup")).toBe("One\ncell\nTwo\n");
    expect(bodyXml(doc)).toHaveLength(3);
  });

  it("rejects an unknown block and a section break record", () => {
    const { doc } = make(p(r("One"), SECT) + p(r("Two")));
    const sectionBreak = doc.getView().body.blocks.find((block) => block.type === "sectionBreak")?.id as string;
    const code = (blockId: string): string => {
      try {
        doc.applyOps([{ type: "insertParagraphAfter", blockId }], DIRECT);
      } catch (error) {
        return isOfficeError(error) ? error.code : "other";
      }
      return "none";
    };
    expect(code("missing")).toBe("stale_reference");
    expect(code(sectionBreak)).toBe("invalid_operation");
  });
});

describe("splitParagraph", () => {
  it("splits directly: the first part keeps the id, the second has the same properties", () => {
    const { doc, ids } = make(p(r("Hello ") + r("brave world", "<w:b/>"), '<w:pStyle w:val="Clause"/>' + SECT) + p(r("Next")));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [{ type: "splitParagraph", at: { blockId: id, offset: 9 } }],
      { ...DIRECT, positions: [{ blockId: id, offset: 4 }, { blockId: id, offset: 12 }] },
    );
    const created = result.createdBlockIds[0] as string;
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:pPr><w:pStyle w:val="Clause"/></w:pPr><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bra</w:t></w:r></w:p>',
    );
    // The section break stays behind the text it followed.
    expect(blockXml(doc, created)).toBe(
      `<w:p><w:pPr><w:pStyle w:val="Clause"/>${SECT}</w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">ve world</w:t></w:r></w:p>`,
    );
    expect(result.results[0]?.caret).toEqual({ blockId: created, offset: 0 });
    expect(result.positions).toEqual([{ blockId: id, offset: 4 }, { blockId: created, offset: 3 }]);
    expect(result.changedBlockIds).toEqual([id]);
    expect(text(doc)).toBe("Hello bra\nve world\nNext\n");
  });

  it("records the split as an inserted paragraph mark", () => {
    const { doc, ids } = make(p(r("Hello brave world")) + p(r("Next")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "splitParagraph", at: { blockId: id, offset: 6 } }], TRACKED);
    expect(blockXml(doc, id)).toMatch(MARK("ins"));
    expect(blockXml(doc, result.createdBlockIds[0] as string)).not.toContain("w:ins");
    expect(text(doc, "final")).toBe("Hello \nbrave world\nNext\n");
    expect(text(doc, "original")).toBe("Hello brave world\nNext\n");
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["insert", "\n"]]);
    doc.rejectRevisions("all");
    expect(bodyXml(doc)).toHaveLength(2);
    expect(paragraphs(doc)[0]).toMatchObject({ id, text: "Hello brave world" });
  });

  it("splits at the ends and inside a pending insertion", () => {
    const { doc, ids } = make(p(r("abc")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 1 }, text: "XY" }], TRACKED);
    doc.applyOps(
      [
        { type: "splitParagraph", at: { blockId: id, offset: 5 } },
        { type: "splitParagraph", at: { blockId: id, offset: 2 } },
        { type: "splitParagraph", at: { blockId: id, offset: 0 } },
      ],
      TRACKED,
    );
    expect(text(doc, "final")).toBe("\naX\nYbc\n\n");
    expect(text(doc, "original")).toBe("abc\n");
    doc.acceptRevisions("all");
    expect(text(doc, "markup")).toBe("\naX\nYbc\n\n");
    expect(bodyXml(doc).join("")).not.toMatch(/w:ins|w:pPr/);
  });
});

describe("deleteParagraph", () => {
  it("removes the paragraph directly and moves positions to the next block", () => {
    const { doc, ids } = make(p(r("One")) + p(r("Two")) + p(r("Three")));
    const [one, two, three] = ids as [string, string, string];
    const result = doc.applyOps([{ type: "deleteParagraph", blockId: two }], { ...DIRECT, positions: [{ blockId: two, offset: 2 }] });
    expect(text(doc)).toBe("One\nThree\n");
    expect(result.removedBlockIds).toEqual([two]);
    expect(result.positions).toEqual([{ blockId: three, offset: 0 }]);
    expect(result.results[0]?.caret).toEqual({ blockId: three, offset: 0 });
    expect(doc.getBlock(two)).toBeNull();
    expect(doc.getBlock(one)).not.toBeNull();
  });

  it("only empties the last paragraph of a story or cell, and one that carries a section break", () => {
    const { doc, ids } = make(p(r("One"), SECT) + tbl(row(cell(p(r("only"))))) + p(r("Last")));
    const [one, last] = ids as [string, string];
    const table = doc.getView().body.blocks.find((block) => block.type === "table");
    if (table?.type !== "table") throw new Error("no table");
    const inCell = table.rows[0]?.cells[0]?.blocks[0]?.id as string;
    const result = doc.applyOps(
      [
        { type: "deleteParagraph", blockId: last },
        { type: "deleteParagraph", blockId: inCell },
        { type: "deleteParagraph", blockId: one },
      ],
      DIRECT,
    );
    expect(result.removedBlockIds).toEqual([]);
    expect(text(doc)).toBe("\n\n\n");
    expect(blockXml(doc, one)).toContain("<w:sectPr>");
  });

  it("records the deletion of the content and of the mark", () => {
    const { doc, ids } = make(p(r("One")) + p(r("Two")) + p(r("Three")));
    const two = ids[1] as string;
    const result = doc.applyOps([{ type: "deleteParagraph", blockId: two }], TRACKED);
    expect(blockXml(doc, two)).toMatch(MARK("del"));
    expect(blockXml(doc, two)).toMatch(/<w:del [^>]*><w:r><w:delText[^>]*>Two<\/w:delText><\/w:r><\/w:del>/);
    expect(text(doc, "final")).toBe("One\nThree\n");
    expect(text(doc, "original")).toBe("One\nTwo\nThree\n");
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["delete", "Two\n"]]);
    expect(result.results[0]?.caret).toEqual({ blockId: two, offset: 0 });
    doc.acceptRevisions("all");
    expect(doc.getBlock(two)).toBeNull();
    expect(paragraphs(doc).map((block) => block.id)).toEqual([ids[0], ids[2]]);
    expect(bodyXml(doc).join("")).not.toMatch(/w:del|w:pPr/);
  });

  it("takes back a paragraph the same author inserted, whichever way it was inserted", () => {
    const { doc, ids } = make(p(r("One")) + p(r("Two")));
    const before = bodyXml(doc);
    const [one, two] = ids as [string, string];
    const after = doc.applyOps([{ type: "insertParagraphAfter", blockId: one, text: "new after" }], TRACKED);
    const front = doc.applyOps([{ type: "insertParagraphBefore", blockId: two, text: "new before" }], TRACKED);
    expect(text(doc, "final")).toBe("One\nnew after\nnew before\nTwo\n");
    const result = doc.applyOps(
      [
        { type: "deleteParagraph", blockId: after.createdBlockIds[0] as string },
        { type: "deleteParagraph", blockId: front.createdBlockIds[0] as string },
      ],
      TRACKED,
    );
    expect(doc.listRevisions()).toEqual([]);
    expect(bodyXml(doc)).toEqual(before);
    expect(result.removedBlockIds).toHaveLength(2);
    expect(paragraphs(doc).map((block) => block.id)).toEqual([one, two]);
  });
});
