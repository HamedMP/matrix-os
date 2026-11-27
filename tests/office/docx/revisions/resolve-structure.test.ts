import { describe, expect, it } from "vitest";

import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { bodyXml, build, documentXml, paragraphs, reopen, text } from "../edit/helpers.js";
import { cell, p, r, row, tbl } from "../model/build.js";

const A = 'w:author="Alex Morgan" w:date="2026-01-05T09:30:00Z"';
const B = 'w:author="Priya Shah" w:date="2026-01-06T14:15:00Z"';
const ins = (id: number, content: string, who = A): string => `<w:ins w:id="${id}" ${who}>${content}</w:ins>`;
const del = (id: number, value: string, who = A): string =>
  `<w:del w:id="${id}" ${who}><w:r><w:delText xml:space="preserve">${value}</w:delText></w:r></w:del>`;
const mark = (name: string, id: number, who = A): string => `<w:rPr><w:${name} w:id="${id}" ${who}/></w:rPr>`;

/** Resolves everything both ways on fresh copies and returns the two documents. */
function both(parts: Parameters<typeof build>[0]): { accepted: DocxDocument; rejected: DocxDocument } {
  const accepted = build(parts);
  accepted.acceptRevisions("all");
  const rejected = build(parts);
  rejected.rejectRevisions("all");
  expect(accepted.listRevisions()).toEqual([]);
  expect(rejected.listRevisions()).toEqual([]);
  return { accepted, rejected };
}

describe("paragraph marks", () => {
  it("joins paragraphs when a mark goes; the first keeps its properties unless it is empty", () => {
    const body =
      p(r("Kept ") + del(1, "gone"), '<w:jc w:val="center"/>' + mark("del", 2)) +
      p(del(3, "all gone"), '<w:jc w:val="right"/>' + mark("del", 4)) +
      p(r("tail"), '<w:jc w:val="both"/>');
    const { accepted, rejected } = both({ body });
    expect(bodyXml(accepted)).toEqual([
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:r><w:t xml:space="preserve">tail</w:t></w:r></w:p>',
    ]);
    expect(text(rejected, "markup")).toBe("Kept gone\nall gone\ntail\n");
    expect(bodyXml(rejected).join("")).not.toMatch(/w:del|w:rPr/);

    // A paragraph that only held deleted text disappears and leaves its neighbour as it was.
    const lone = build({ body: p(del(1, "all gone"), '<w:jc w:val="right"/>' + mark("del", 2)) + p(r("tail"), '<w:jc w:val="both"/>') });
    const tail = paragraphs(lone)[1]?.id as string;
    const result = lone.acceptRevisions("all");
    expect(bodyXml(lone)).toEqual(['<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t xml:space="preserve">tail</w:t></w:r></w:p>']);
    expect(paragraphs(lone)[0]?.id).toBe(tail);
    expect(result.removedBlockIds).toHaveLength(1);
  });

  it("removes an empty paragraph whose mark went and that has nothing to join", () => {
    const body = p(r("Stays")) + p(ins(1, r("appended")), mark("ins", 2));
    const { accepted, rejected } = both({ body });
    expect(text(accepted, "markup")).toBe("Stays\nappended\n");
    expect(bodyXml(rejected)).toEqual(['<w:p><w:r><w:t xml:space="preserve">Stays</w:t></w:r></w:p>']);

    // In front of a table the same paragraph goes too; the only paragraph of a cell stays.
    const table = p(ins(1, r("new")), mark("ins", 2)) + tbl(row(cell(p(ins(3, r("x")), mark("ins", 4))))) + p(r("End"));
    const second = both({ body: table });
    expect(text(second.rejected, "markup")).toBe("\nEnd\n");
    expect(bodyXml(second.rejected)).toHaveLength(2);
    expect(bodyXml(second.rejected)[0]).toMatch(/^<w:tbl>.*<w:tc><w:p><\/w:p><\/w:tc>/);
  });

  it("carries the mark state and the section break of the second paragraph over a join", () => {
    const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
    const body = p(r("One "), mark("ins", 1)) + p(r("two"), mark("del", 2, B) + sect) + p(r(" three"));
    const doc = build({ body });
    const [insertion, deletion] = doc.listRevisions();
    doc.rejectRevisions([insertion?.id as string]);
    expect(bodyXml(doc)[0]).toBe(
      `<w:p><w:pPr><w:rPr><w:del w:id="2" ${B}/></w:rPr>${sect}</w:pPr><w:r><w:t xml:space="preserve">One </w:t></w:r><w:r><w:t xml:space="preserve">two</w:t></w:r></w:p>`,
    );
    // The deletion is the same revision as before, on the joined paragraph.
    expect(doc.listRevisions().map((revision) => revision.id)).toEqual([deletion?.id]);
    const breaks = (): number => doc.getView().body.blocks.filter((block) => block.type === "sectionBreak").length;
    expect(breaks()).toBe(1);
    doc.acceptRevisions("all");
    // The mark that carried the section break is gone, and the break with it.
    expect(text(doc, "markup")).toBe("One two three\n");
    expect(breaks()).toBe(0);
  });

  it("resolves a mark that one author inserted and another deleted", () => {
    const body = p(r("One"), `<w:rPr><w:ins w:id="1" ${A}/><w:del w:id="2" ${B}/></w:rPr>`) + p(r("Two"));
    const { accepted, rejected } = both({ body });
    expect(text(accepted, "markup")).toBe("OneTwo\n");
    expect(text(rejected, "markup")).toBe("OneTwo\n");
    expect(documentXml(accepted)).not.toMatch(/w:ins|w:del|w:pPr/);
    const single = build({ body });
    single.acceptRevisions([single.listRevisions()[0]?.id as string]);
    // The insertion is settled; the deletion of the mark is still pending.
    expect(single.listRevisions().map((revision) => [revision.kind, revision.author])).toEqual([["delete", "Priya Shah"]]);
    expect(text(single, "final")).toBe("OneTwo\n");
    expect(text(single, "original")).toBe("One\nTwo\n");
  });

  it("resolves a formatting change of the mark and keeps the mark revision", () => {
    const body = p(r("One"), `<w:rPr><w:ins w:id="1" ${A}/><w:b/><w:rPrChange w:id="2" ${B}><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>`) + p(r("Two"));
    const doc = build({ body });
    const change = doc.listRevisions().find((revision) => revision.kind === "format");
    doc.rejectRevisions([change?.id as string]);
    expect(bodyXml(doc)[0]).toContain(`<w:pPr><w:rPr><w:ins w:id="1" ${A}/><w:i/></w:rPr></w:pPr>`);
    expect(doc.listRevisions()).toHaveLength(1);
  });
});

describe("content", () => {
  it("keeps bookmarks and comment ranges whose ends sit in removed text", () => {
    const body = p(
      r("Before ") +
        `<w:ins w:id="1" ${A}><w:bookmarkStart w:id="50" w:name="_Ref1"/><w:r><w:t>inserted</w:t></w:r><w:commentRangeEnd w:id="0"/></w:ins>` +
        '<w:bookmarkEnd w:id="50"/>' +
        r(" after"),
    );
    const { rejected } = both({ body });
    expect(bodyXml(rejected)[0]).toBe(
      '<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:bookmarkStart w:id="50" w:name="_Ref1"/><w:commentRangeEnd w:id="0"/>' +
        '<w:bookmarkEnd w:id="50"/><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>',
    );
  });

  it("removes a link that only held removed text and restores a deleted field code", () => {
    const body = p(
      r("See ") +
        `<w:hyperlink w:anchor="_Ref1">${ins(1, r("the link"))}</w:hyperlink>` +
        `<w:del w:id="2" ${A}><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:delInstrText xml:space="preserve"> DATE </w:delInstrText></w:r>` +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:delText>1 May</w:delText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:del>',
    );
    const { accepted, rejected } = both({ body });
    expect(bodyXml(rejected)[0]).not.toContain("w:hyperlink");
    expect(bodyXml(rejected)[0]).toContain('<w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r>');
    expect(text(rejected, "markup")).toBe("See 1 May\n");
    expect(bodyXml(accepted)[0]).toContain('<w:hyperlink w:anchor="_Ref1"><w:r>');
    expect(bodyXml(accepted)[0]).not.toContain("fldChar");
  });

  it("resolves revisions in headers and footnotes", async () => {
    const doc = build({
      body: p(r("Body") + '<w:r><w:footnoteReference w:id="2"/></w:r>') + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
      headers: { rIdH: p(r("Head ") + ins(1, r("draft")) + del(2, "final")) },
      footnotes:
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
        `<w:footnote w:id="2">${p(r("Note ") + del(3, "old") + ins(4, r("new")))}</w:footnote>`,
    });
    const header = doc.getView().headers[0]?.id as string;
    const footnote = doc.getView().footnotes[0]?.id as string;
    const result = doc.acceptRevisions("all");
    expect(result.changedStoryIds).toEqual([header, footnote]);
    expect(doc.getPlainText({ storyId: header })).toBe("Head draft\n");
    expect(doc.getPlainText({ storyId: footnote })).toBe("Note new\n");
    const again = await reopen(doc);
    expect(again.listRevisions()).toEqual([]);
    expect(again.getPlainText({ storyId: footnote })).toBe("Note new\n");
  });
});

describe("tables and property changes", () => {
  const cellMark = (name: string, id: number): string => `<w:${name} w:id="${id}" ${A}/>`;

  it("removes a table whose rows all go, and keeps its story valid", () => {
    const deletedRow = (id: number, value: string): string =>
      row(cell(p(del(id, value), mark("del", id + 1))), `<w:del w:id="${id + 2}" ${A}/>`);
    const body = p(r("Before")) + tbl(deletedRow(1, "a") + deletedRow(4, "b")) + p(r("After"));
    const { accepted, rejected } = both({ body });
    expect(text(accepted, "markup")).toBe("Before\nAfter\n");
    expect(bodyXml(accepted)).toHaveLength(2);
    expect(text(rejected, "markup")).toBe("Before\na\nb\nAfter\n");
    expect(bodyXml(rejected).join("")).not.toMatch(/w:del|w:trPr|w:pPr/);

    const only = build({ body: tbl(deletedRow(1, "a")) });
    only.acceptRevisions("all");
    expect(bodyXml(only)).toHaveLength(1);
    expect(bodyXml(only)[0]).toMatch(/^<w:p/);
    expect(text(only, "markup")).toBe("\n");
  });

  it("restores or keeps table, row, cell and section properties", () => {
    const change = (name: string, id: number, old: string): string => `<w:${name}Change w:id="${id}" ${A}>${old}</w:${name}Change>`;
    const table =
      "<w:tbl>" +
      `<w:tblPr><w:tblW w:w="5000" w:type="dxa"/>${change("tblPr", 1, '<w:tblPr><w:tblW w:w="3000" w:type="dxa"/></w:tblPr>')}</w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="5000"/>${change("tblGrid", 2, '<w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>')}</w:tblGrid>` +
      "<w:tr>" +
      `<w:trPr><w:trHeight w:val="500"/><w:ins w:id="9" ${B}/>${change("trPr", 3, '<w:trPr><w:trHeight w:val="300"/></w:trPr>')}</w:trPr>` +
      `<w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/>${change("tcPr", 4, '<w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>')}</w:tcPr>${p(r("cell"))}</w:tc>` +
      "</w:tr></w:tbl>";
    const section =
      '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' +
      `${change("sectPr", 5, '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>')}</w:sectPr>`;
    const parts = { body: table + p(r("End")) + section, headers: { rIdH: p(r("Head")) } };
    const doc = build(parts);
    const formats = doc.listRevisions().filter((revision) => revision.kind === "format").map((revision) => revision.id);
    const snapshot = doc.snapshot();
    doc.rejectRevisions(formats);
    const rejected = documentXml(doc);
    expect(rejected).toContain('<w:tblPr><w:tblW w:w="3000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>');
    // The pending row insertion is not part of the formatting revisions and stays.
    expect(rejected).toContain(`<w:trPr><w:trHeight w:val="300"/><w:ins w:id="9" ${B}/></w:trPr>`);
    expect(rejected).toContain('<w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>');
    expect(rejected).toContain('<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
    expect(doc.getView().sections[0]).toMatchObject({ orientation: "portrait" });
    expect(doc.getView().headers).toHaveLength(1);
    doc.restore(snapshot);
    doc.acceptRevisions(formats);
    const accepted = documentXml(doc);
    expect(accepted).not.toMatch(/Change /);
    expect(accepted).toContain('<w:tblW w:w="5000" w:type="dxa"/>');
    expect(accepted).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>');
    expect(doc.listRevisions().map((revision) => revision.scope)).toEqual(["tableRow"]);
  });

  it("resolves inserted, deleted and merged cells", () => {
    const body = tbl(
      row(
        cell(p(r("kept"))) +
          cell(p(r("inserted")), cellMark("cellIns", 1)) +
          cell(p(r("deleted")), cellMark("cellDel", 2)) +
          cell(p(r("merged")), `<w:vMerge w:val="restart"/><w:cellMerge w:id="3" ${A} w:vMerge="rest"/>`),
      ),
    );
    const cells = (doc: DocxDocument): string[] => {
      const table = doc.getView().body.blocks[0];
      if (table?.type !== "table") throw new Error("no table");
      return (table.rows[0]?.cells ?? []).map((entry) => (entry.blocks[0]?.type === "paragraph" ? entry.blocks[0].text : ""));
    };
    const { accepted, rejected } = both({ body });
    expect(cells(accepted)).toEqual(["kept", "inserted", "merged"]);
    expect(cells(rejected)).toEqual(["kept", "deleted", "merged"]);
    expect(documentXml(accepted)).toContain('<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>');
    expect(documentXml(rejected)).not.toMatch(/w:cell(Ins|Del|Merge)|w:vMerge/);
  });
});
