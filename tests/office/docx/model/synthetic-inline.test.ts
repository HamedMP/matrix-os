import { describe, expect, it } from "vitest";

import type { ParagraphBlock, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { buildDocument, cell, p, r, row, tbl } from "./build.js";

const first = (document: ReturnType<typeof buildDocument>): ParagraphBlock => document.getView().body.blocks[0] as ParagraphBlock;

describe("run formatting", () => {
  const styles =
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Loud"><w:name w:val="Loud"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Base"><w:name w:val="Base"/><w:rPr><w:i/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Base"/><w:rPr><w:u w:val="none"/><w:strike/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="LoopA"><w:name w:val="LoopA"/><w:basedOn w:val="LoopB"/><w:rPr><w:i/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="LoopB"><w:name w:val="LoopB"/><w:basedOn w:val="LoopA"/></w:style>';

  it("layers defaults, paragraph style, character style and direct formatting", () => {
    const document = buildDocument({
      styles,
      body: p(
        r("plain") +
          r("off", '<w:b w:val="0"/><w:color w:val="auto"/>') +
          r("styled", '<w:rStyle w:val="Derived"/>') +
          r("marked", '<w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/><w:sz w:val="16"/>') +
          r("shaded", '<w:shd w:val="clear" w:fill="00FF00"/><w:rFonts w:hAnsi="Arial"/>') +
          r("loop", '<w:rStyle w:val="LoopA"/>'),
        '<w:pStyle w:val="Loud"/>',
      ),
    });
    const runs = first(document).runs;
    expect(runs.map((run) => run.text)).toEqual(["plain", "off", "styled", "marked", "shaded", "loop"]);
    expect(runs[0]).toMatchObject({ bold: true, color: "#ff0000", fontFamily: "Georgia", fontSizePt: 12, italic: false });
    expect(runs[1]).toMatchObject({ bold: false, color: null });
    expect(runs[2]).toMatchObject({ bold: true, italic: true, underline: false, strike: true });
    expect(runs[3]).toMatchObject({ highlight: "#ffff00", verticalAlign: "superscript", fontSizePt: 8 });
    expect(runs[4]).toMatchObject({ highlight: "#00ff00", fontFamily: "Arial" });
    // A style that is based on itself through another does not hang the resolver.
    expect(runs[5]).toMatchObject({ italic: true });
  });

  it("merges neighbouring runs with the same formatting and keeps empty runs out", () => {
    const document = buildDocument({ body: p(`${r("a")}<w:r/>${r("b")}${r("c", "<w:b/>")}${r("d", "<w:b/>")}<w:r><w:rPr><w:b/></w:rPr></w:r>`) });
    expect(first(document).runs.map((run) => [run.start, run.text, run.bold])).toEqual([
      [0, "ab", false],
      [2, "cd", true],
    ]);
    expect(buildDocument({ body: p("") }).getView().body.blocks[0]).toMatchObject({ text: "", runs: [] });
  });
});

describe("inline objects, links and fields", () => {
  it("gives every object one U+FFFC and describes images, breaks and unknown content", () => {
    const drawing =
      '<w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="1" name="Picture 1" descr="A chart"/>' +
      '<a:graphic><a:graphicData><a:blip r:embed="img1"/></a:graphicData></a:graphic></wp:inline></w:drawing>';
    const document = buildDocument({
      images: { img1: new Uint8Array([137, 80, 78, 71]) },
      body: p(
        `${r("x")}<w:r>${drawing}</w:r><w:r><w:br w:type="page"/></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>` +
          `<m:oMath><m:r><m:t>e=mc2</m:t></m:r></m:oMath><w:r><w:drawing><wp:inline/></w:drawing></w:r>${r("y")}`,
      ),
    });
    const block = first(document);
    expect(block.text).toBe("x￼￼￼￼￼y");
    expect(block.runs.map((run) => run.object)).toEqual([
      null,
      { kind: "image", partName: "/word/media/img1.png", contentType: "image/png", widthPt: 100, heightPt: 50, altText: "A chart" },
      { kind: "break", breakType: "page" },
      { kind: "other", elementName: "w:sym" },
      { kind: "other", elementName: "m:oMath" },
      { kind: "other", elementName: "w:drawing" },
      null,
    ]);
    expect(document.getPlainText()).toBe("xy\n");
    const scan = getDocxIndex(document).scan(block.id);
    expect(scan.atoms[4]).toMatchObject({ kind: "object", run: null });
  });

  it("reads a link made by a HYPERLINK field and hides fields nested in a field code", () => {
    const fld = (type: string): string => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
    const code = (text: string): string => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`;
    const document = buildDocument({
      body:
        p(`${r("Go to ")}${fld("begin")}${code(' HYPERLINK "https://example.org/x" \\l "part2" \\o "Open" ')}${fld("separate")}${r("the site")}${fld("end")}${r(".")}`) +
        p(`${fld("begin")}${code(" IF ")}${fld("begin")}${code(" MERGEFIELD Amount ")}${fld("separate")}${r("100")}${fld("end")}${code(' > 50 "big" "small" ')}${fld("separate")}${r("big")}${fld("end")}`) +
        p(`${fld("begin")}${code(" PAGE ")}${fld("end")}${r("no result")}`),
    });
    const blocks = document.getView().body.blocks as ParagraphBlock[];
    expect(blocks[0]?.text).toBe("Go to the site.");
    expect(blocks[0]?.runs[1]).toMatchObject({
      text: "the site",
      hyperlink: { href: "https://example.org/x", anchor: "part2", tooltip: "Open" },
      field: { kind: "hyperlink" },
    });
    expect(blocks[0]?.runs[2]?.hyperlink).toBeNull();
    // The inner field result belongs to the code of the outer field.
    expect(blocks[1]?.text).toBe("big");
    expect(blocks[1]?.runs[0]?.field).toMatchObject({ kind: "other", instruction: 'IF  > 50 "big" "small"' });
    expect(blocks[2]?.text).toBe("no result");
    expect(blocks[2]?.runs[0]?.field).toBeNull();
    // A link into the document is a cross-reference; its bookmark does not exist here.
    expect(document.getCrossReferences().map((reference) => [reference.text, reference.source, reference.broken])).toEqual([
      ["the site", "field", true],
    ]);
  });
});

describe("comments in unusual shapes", () => {
  const comment = (id: string, paraId: string, text: string, date: string): string =>
    `<w:comment w:id="${id}" w:author="Sam" w:date="${date}"><w:p w14:paraId="${paraId}">${r(text)}</w:p><w:p w14:paraId="${paraId}F">${r("second line")}</w:p></w:comment>`;
  const start = (id: string): string => `<w:commentRangeStart w:id="${id}"/>`;
  const end = (id: string): string => `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;

  it("handles ranges across paragraphs, point anchors, resolved threads and comments without an anchor", () => {
    const document = buildDocument({
      body:
        p(`${r("One ")}${start("5")}${r("two")}`) +
        p(`${r("three")}${end("5")}${r(" four")}<w:r><w:commentReference w:id="6"/></w:r>`) +
        p(`${start("8")}${r("early")}${end("8")}`),
      comments: comment("5", "AA000001", "across", "2026-03-01T10:00:00Z") + comment("6", "AA000002", "point", "2026-03-01T11:00:00Z") + comment("7", "AA000003", "lost", "2026-03-01T12:00:00Z") + comment("8", "AA000004", "third", "2026-03-01T09:00:00Z") + comment("9", "AA000005", "late reply", "2026-03-02T09:00:00Z") + comment("10", "AA000006", "early reply", "2026-03-01T13:00:00Z"),
      commentsExtended:
        '<w15:commentEx w15:paraId="AA000001F" w15:done="1"/><w15:commentEx w15:paraId="AA000005F" w15:paraIdParent="AA000001F" w15:done="0"/>' +
        '<w15:commentEx w15:paraId="AA000006F" w15:paraIdParent="AA000001F"/>',
    });
    const blocks = document.getView().body.blocks as ParagraphBlock[];
    const comments = document.listComments();
    expect(comments.map((entry) => [entry.id, entry.parentId, entry.resolved, entry.anchorText])).toEqual([
      ["5", null, true, "two\nthree"],
      ["10", "5", true, "two\nthree"],
      ["9", "5", true, "two\nthree"],
      ["6", null, false, ""],
      ["8", null, false, "early"],
      ["7", null, false, ""],
    ]);
    expect(comments[0]?.text).toBe("across\nsecond line");
    expect(comments[0]?.range).toEqual({ start: { blockId: blocks[0]?.id, offset: 4 }, end: { blockId: blocks[1]?.id, offset: 5 } });
    expect(comments[3]?.range).toEqual({ start: { blockId: blocks[1]?.id, offset: 10 }, end: { blockId: blocks[1]?.id, offset: 10 } });
    expect(comments[5]?.range).toBeNull();
    // A range that stays open across a paragraph boundary covers the runs on both sides.
    expect(blocks[0]?.runs.map((run) => run.commentIds)).toEqual([[], ["5"]]);
    expect(blocks[1]?.runs.map((run) => [run.text, run.commentIds])).toEqual([
      ["three", ["5"]],
      [" four", []],
    ]);
  });
});

describe("revision grouping", () => {
  const who = 'w:author="Sam" w:date="2026-02-01T00:00:00Z"';
  const other = 'w:author="Kim" w:date="2026-02-01T00:00:00Z"';
  const ins = (content: string, id: number, by = who): string => `<w:ins w:id="${id}" ${by}>${content}</w:ins>`;
  const del = (text: string, id: number, by = who): string => `<w:del w:id="${id}" ${by}><w:r><w:delText>${text}</w:delText></w:r></w:del>`;
  const mark = (name: string, id: number, by = who): string => `<w:rPr><w:${name} w:id="${id}" ${by}/></w:rPr>`;

  it("joins inserted paragraphs typed in one edit and stops at unrevised text or another author", () => {
    const document = buildDocument({
      body:
        p(r("kept ") + ins(r("tail"), 1), mark("ins", 2)) +
        p(ins(r("whole"), 3), mark("ins", 4)) +
        p(ins(r("head"), 5) + r(" kept")) +
        p(ins(r("by Kim"), 6, other)) +
        p(ins(r("apart"), 7)),
    });
    const blocks = document.getView().body.blocks as ParagraphBlock[];
    const revisions = document.listRevisions();
    expect(revisions.map((revision) => [revision.author, revision.text, revision.blockIds.length])).toEqual([
      ["Sam", "tail\nwhole\nhead", 3],
      ["Kim", "by Kim", 1],
      ["Sam", "apart", 1],
    ]);
    expect(revisions[0]?.range).toEqual({ start: { blockId: blocks[0]?.id, offset: 5 }, end: { blockId: blocks[2]?.id, offset: 4 } });
    expect(document.getPlainText({ range: revisions[0]!.range!, view: "markup" })).toBe("tail\nwhole\nhead");
    expect(blocks.map((block) => block.markRevision?.revisionId ?? null)).toEqual([revisions[0]?.id, revisions[0]?.id, null, null, null]);
    expect(document.getPlainText({ view: "original" })).toBe("kept  kept\n\n\n");
  });

  it("treats a replacement written insertion-first as a pair too, and leaves unrelated changes unpaired", () => {
    const document = buildDocument({ body: p(ins(r("new"), 1) + del("old", 2) + r(" and ") + del("gone", 3) + r(" x ") + ins(r("added"), 4)) });
    const revisions = document.listRevisions();
    expect(revisions.map((revision) => [revision.kind, revision.text, revision.pairedWith])).toEqual([
      ["insert", "new", revisions[1]?.id],
      ["delete", "old", revisions[0]?.id],
      ["delete", "gone", null],
      ["insert", "added", null],
    ]);
  });

  it("groups deleted rows, paragraph format changes and table property changes", () => {
    const tracked = (name: string, id: number): string => `<w:${name} w:id="${id}" ${who}/>`;
    const document = buildDocument({
      body:
        p(r("a"), `<w:jc w:val="right"/><w:pPrChange w:id="1" ${who}><w:pPr/></w:pPrChange>`) +
        p(r("b"), `<w:pStyle w:val="Nope"/><w:ind w:left="720"/><w:pPrChange w:id="2" ${who}><w:pPr><w:ind w:left="0"/></w:pPr></w:pPrChange>`) +
        tbl(
          row(cell(p(r("keep")), `<w:tcW w:w="100" w:type="dxa"/><w:tcPrChange w:id="3" ${who}><w:tcPr/></w:tcPrChange>`)) +
            row(cell(p(del("r1", 5))), tracked("del", 4)) +
            row(cell(p(del("r2", 7) + ins(r("other change"), 8))), tracked("del", 6)),
        ) +
        `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:sectPrChange w:id="9" ${other}><w:sectPr/></w:sectPrChange></w:sectPr>`,
    });
    const view = document.getView();
    const table = view.body.blocks[2] as TableBlock;
    const revisions = document.listRevisions();
    expect(revisions.map((revision) => [revision.kind, revision.scope, revision.author, revision.text])).toEqual([
      ["format", "paragraphFormat", "Sam", "a\nb"],
      ["format", "paragraphFormat", "Sam", ""],
      ["delete", "tableRow", "Sam", "r1\nr2other change"],
      ["insert", "text", "Sam", "other change"],
      ["format", "paragraphFormat", "Kim", ""],
    ]);
    expect(revisions[0]?.formatChange).toEqual({ before: { alignment: "left" }, after: { alignment: "right" } });
    expect(revisions[0]?.blockIds).toEqual([view.body.blocks[0]?.id, view.body.blocks[1]?.id]);
    expect(revisions[1]?.blockIds).toEqual([table.id]);
    expect(table.rows.map((entry) => entry.revision?.kind ?? null)).toEqual([null, "delete", "delete"]);
    expect(table.rows[1]?.revision?.revisionId).toBe(table.rows[2]?.revision?.revisionId);
    const groups = getDocxIndex(document).revisions.groups;
    expect(groups[1]?.members.map((member) => `${member.role}:${member.element.name}`)).toEqual(["otherFormat:w:tcPrChange"]);
    expect(groups[4]?.members.map((member) => member.element.name)).toEqual(["w:sectPrChange"]);
    // Deleted rows are gone in the final text and present in the original.
    expect(document.getPlainText()).toBe("a\nb\nkeep\n");
    expect(document.getPlainText({ view: "original" })).toBe("a\nb\nkeep\nr1\nr2\n");
  });

  it("lists the revisions of notes after those of the body", () => {
    const document = buildDocument({
      body: p(`${r("text")}<w:r><w:footnoteReference w:id="2"/></w:r>${ins(r(" more"), 10)}`),
      footnotes: `<w:footnote w:id="2">${p(del("note change", 11, other))}</w:footnote>`,
    });
    expect(document.listRevisions().map((revision) => [revision.storyId, revision.kind, revision.author])).toEqual([
      ["body", "insert", "Sam"],
      ["footnote:2", "delete", "Kim"],
    ]);
    expect(document.getView().revisionCount).toBe(2);
  });
});

describe("plain text ranges and defined terms", () => {
  it("returns the text of a range within and across sibling paragraphs and validates it", () => {
    const document = buildDocument({ body: p(r("alpha beta")) + tbl(row(cell(p(r("c1"))) + cell(p(r("c2"))))) + p(r("gamma delta")) });
    const view = document.getView();
    const [a, table, c] = view.body.blocks as [ParagraphBlock, TableBlock, ParagraphBlock];
    const at = (blockId: string, offset: number) => ({ blockId, offset });
    expect(document.getPlainText({ range: { start: at(a.id, 6), end: at(a.id, 10) } })).toBe("beta");
    expect(document.getPlainText({ range: { start: at(a.id, 6), end: at(c.id, 5) } })).toBe("beta\nc1\tc2\ngamma");
    expect(document.getPlainText({ range: { start: at(a.id, 3), end: at(a.id, 3) } })).toBe("");
    const inCell = table.rows[0]!.cells[0]!.blocks[0]!.id;
    const code = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return isOfficeError(error) ? error.code : "other";
      }
      return "none";
    };
    expect(code(() => document.getPlainText({ range: { start: at(a.id, 0), end: at(inCell, 1) } }))).toBe("invalid_argument");
    expect(code(() => document.getPlainText({ range: { start: at(c.id, 0), end: at(a.id, 1) } }))).toBe("invalid_argument");
    expect(code(() => document.getPlainText({ range: { start: at(a.id, 4), end: at(a.id, 2) } }))).toBe("invalid_argument");
    expect(code(() => document.getPlainText({ range: { start: at(a.id, 0), end: at(a.id, 99) } }))).toBe("stale_reference");
    expect(code(() => document.getPlainText({ range: { start: at("x", 0), end: at(a.id, 1) } }))).toBe("stale_reference");
    expect(code(() => document.getPlainText({ range: { start: at(table.id, 0), end: at(a.id, 1) } }))).toBe("invalid_operation");
    expect(code(() => document.getPlainText({ view: "draft" as never }))).toBe("invalid_argument");
  });

  it("finds bold terms, straight and single quotes, and several definitions in one paragraph", () => {
    const document = buildDocument({
      body:
        p(r("Fee", "<w:b/>") + r(" means the amount due. ") + r("Party", "<w:b/>") + r(" shall mean a signatory.")) +
        p(r('"Law" includes regulations; and ‘Tax’ has the meaning given by statute.')) +
        p(r("The “so-called” service and a ") + r("bold phrase", "<w:b/>") + r(" that defines nothing.")) +
        p(r("Acme Ltd (together with its affiliates, the “Group”) agrees.")) +
        p(r("Bolt plc (the “Seller” or “Vendor”) and (see the “Notes” below).")),
    });
    const terms = document.getDefinedTerms();
    expect(terms.map((term) => [term.term, term.marker, term.definition])).toEqual([
      ["Fee", "bold", "means the amount due."],
      ["Party", "bold", "shall mean a signatory."],
      ["Law", "quoted", "includes regulations; and"],
      ["Tax", "quoted", "has the meaning given by statute."],
      ["Group", "quoted", "Acme Ltd"],
      ["Seller", "quoted", "Bolt plc"],
      ["Vendor", "quoted", "Bolt plc"],
    ]);
    for (const term of terms) expect(document.getPlainText({ range: term.range })).toBe(term.term);
  });
});
