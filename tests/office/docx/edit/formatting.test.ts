import { describe, expect, it } from "vitest";

import type { DocxDocument, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { p, r } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, bodyXml, build, paragraphs, reopen, text } from "./helpers.js";

const STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Strong"><w:name w:val="Strong Text"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>';
const INS = (author: string, content: string): string =>
  `<w:ins w:id="900" w:author="${author}" w:date="2026-01-01T00:00:00Z">${content}</w:ins>`;

function make(body: string, styles: string | undefined = STYLES): { doc: DocxDocument; ids: string[] } {
  const doc = build(styles === undefined ? { body } : { body, styles });
  return { doc, ids: paragraphs(doc).map((block) => block.id) };
}

function block(doc: DocxDocument, id: string): ParagraphBlock {
  const found = doc.getBlock(id);
  if (found?.type !== "paragraph") throw new Error("not a paragraph");
  return found;
}

const range = (a: string, from: number, b: string, to: number) => ({
  start: { blockId: a, offset: from },
  end: { blockId: b, offset: to },
});

describe("setRunFormat", () => {
  it("formats part of a run directly, in schema order, and leaves the rest alone", () => {
    const { doc, ids } = make(p(r("Hello brave world", '<w:rFonts w:ascii="Georgia"/><w:lang w:val="en-GB"/>')));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [
        {
          type: "setRunFormat",
          range: range(id, 6, id, 11),
          format: { bold: true, italic: true, underline: true, strike: true, color: "#1a2b3c", highlight: "#ffff00", fontSizePt: 14, verticalAlign: "superscript" },
        },
      ],
      DIRECT,
    );
    expect(blockXml(doc, id)).toContain(
      '<w:r><w:rPr><w:rFonts w:ascii="Georgia"/><w:b/><w:bCs/><w:i/><w:iCs/><w:strike/><w:color w:val="1A2B3C"/>' +
        '<w:sz w:val="28"/><w:szCs w:val="28"/><w:highlight w:val="yellow"/><w:u w:val="single"/><w:vertAlign w:val="superscript"/>' +
        '<w:lang w:val="en-GB"/></w:rPr><w:t xml:space="preserve">brave</w:t></w:r>',
    );
    expect(block(doc, id).runs.map((run) => [run.text, run.bold, run.fontSizePt, run.highlight, run.verticalAlign])).toEqual([
      ["Hello ", false, null, null, "baseline"],
      ["brave", true, 14, "#ffff00", "superscript"],
      [" world", false, null, null, "baseline"],
    ]);
    expect(result.results[0]).toMatchObject({ caret: null, revisionIds: [] });
    expect(result.changedBlockIds).toEqual([id]);
    expect(text(doc)).toBe("Hello brave world\n");
  });

  it("switches a property off explicitly only when the styles would switch it on", () => {
    const { doc, ids } = make(
      p(r("direct bold", "<w:b/>")) + p(r("style bold"), '<w:pStyle w:val="Strong"/>') + p(r("styled run", '<w:rStyle w:val="Emphasis"/>')),
    );
    const [direct, styled, character] = ids as [string, string, string];
    doc.applyOps(
      [
        { type: "setRunFormat", range: range(direct, 0, direct, 11), format: { bold: false } },
        { type: "setRunFormat", range: range(styled, 0, styled, 10), format: { bold: false } },
        { type: "setRunFormat", range: range(character, 0, character, 10), format: { italic: false, color: null, fontFamily: "Arial", highlight: "#123456" } },
      ],
      DIRECT,
    );
    expect(blockXml(doc, direct)).toBe('<w:p><w:r><w:t xml:space="preserve">direct bold</w:t></w:r></w:p>');
    expect(blockXml(doc, styled)).toContain('<w:r><w:rPr><w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>');
    expect(blockXml(doc, character)).toContain(
      '<w:rPr><w:rStyle w:val="Emphasis"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>' +
        '<w:i w:val="0"/><w:iCs w:val="0"/><w:shd w:val="clear" w:color="auto" w:fill="123456"/></w:rPr>',
    );
    expect(block(doc, styled).runs[0]?.bold).toBe(false);
    expect(block(doc, character).runs[0]).toMatchObject({ italic: false, fontFamily: "Arial", highlight: "#123456" });
  });

  it("records the previous properties in w:rPrChange", async () => {
    const { doc, ids } = make(p(r("Hello ") + r("brave", "<w:i/>") + r(" world")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "setRunFormat", range: range(id, 3, id, 14), format: { bold: true } }], TRACKED);
    const change = (old: string): string =>
      `<w:rPrChange w:id="\\d+" w:author="${RAE}" w:date="${DATE}"><w:rPr${old === "" ? "/>" : `>${old}</w:rPr>`}</w:rPrChange>`;
    const xml = blockXml(doc, id);
    expect(xml).toMatch(new RegExp(`<w:r><w:rPr><w:b/><w:bCs/>${change("")}</w:rPr><w:t xml:space="preserve">lo </w:t></w:r>`));
    expect(xml).toMatch(new RegExp(`<w:r><w:rPr><w:b/><w:bCs/><w:i/>${change("<w:i/>")}</w:rPr><w:t xml:space="preserve">brave</w:t></w:r>`));
    expect(xml).toContain('<w:r><w:t xml:space="preserve">Hel</w:t></w:r>');
    const revisions = doc.listRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      kind: "format",
      scope: "runFormat",
      author: RAE,
      text: "lo brave wo",
      formatChange: { before: { bold: false }, after: { bold: true } },
      range: range(id, 3, id, 14),
    });
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(block(doc, id).runs.find((run) => run.text === "brave")?.formatRevision?.kind).toBe("format");

    const rejected = await reopen(doc);
    rejected.rejectRevisions("all");
    expect(block(rejected, paragraphs(rejected)[0]?.id as string).runs.map((run) => [run.text, run.bold, run.italic])).toEqual([
      ["Hello ", false, false],
      ["brave", false, true],
      [" world", false, false],
    ]);
    expect(bodyXml(rejected).join("")).not.toMatch(/rPrChange|<w:b\/>/);
    doc.acceptRevisions("all");
    expect(bodyXml(doc).join("")).not.toContain("rPrChange");
    expect(block(doc, id).runs.find((run) => run.text.includes("brave"))?.bold).toBe(true);
  });

  it("keeps the first record when formatted again, and records nothing when nothing changes", () => {
    const { doc, ids } = make(p(r("plain ") + r("bold", "<w:b/>")));
    const id = ids[0] as string;
    const none = doc.applyOps([{ type: "setRunFormat", range: range(id, 6, id, 10), format: { bold: true } }], TRACKED);
    expect(none.revisionIds).toEqual([]);
    expect(none.changedBlockIds).toEqual([]);
    expect(doc.listRevisions()).toEqual([]);
    doc.applyOps([{ type: "setRunFormat", range: range(id, 0, id, 6), format: { italic: true } }], TRACKED);
    doc.applyOps([{ type: "setRunFormat", range: range(id, 0, id, 6), format: { underline: true } }], TRACKED);
    expect(blockXml(doc, id).match(/w:rPrChange /g)).toHaveLength(1);
    expect(doc.listRevisions()[0]?.formatChange).toEqual({
      before: { italic: false, underline: false },
      after: { italic: true, underline: true },
    });
  });

  it("formats its own pending insertion without a record, and skips deleted text", () => {
    const { doc, ids } = make(p(r("a") + INS(RAE, r("MINE")) + r("z")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "deleteRange", range: range(id, 5, id, 6) }], { ...TRACKED, author: "Alex Morgan" });
    doc.applyOps([{ type: "setRunFormat", range: range(id, 1, id, 6), format: { bold: true } }], TRACKED);
    const xml = blockXml(doc, id);
    expect(xml).toContain('<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">MINE</w:t></w:r>');
    expect(xml).not.toContain("rPrChange");
    expect(xml).toMatch(/<w:del [^>]*><w:r><w:delText[^>]*>z<\/w:delText><\/w:r><\/w:del>/);
  });

  it("formats a range across paragraphs", () => {
    const { doc, ids } = make(p(r("first one")) + p(r("middle")) + p(r("last one")));
    const [first, middle, last] = ids as [string, string, string];
    doc.applyOps([{ type: "setRunFormat", range: range(first, 6, last, 4), format: { bold: true } }], TRACKED);
    expect(block(doc, first).runs.map((run) => [run.text, run.bold])).toEqual([["first ", false], ["one", true]]);
    expect(block(doc, middle).runs.map((run) => [run.text, run.bold])).toEqual([["middle", true]]);
    expect(block(doc, last).runs.map((run) => [run.text, run.bold])).toEqual([["last", true], [" one", false]]);
    expect(doc.listRevisions().every((revision) => revision.kind === "format")).toBe(true);
  });

  it("rejects malformed formats", () => {
    const { doc, ids } = make(p(r("text")));
    const id = ids[0] as string;
    for (const format of [{ bold: "yes" }, { color: "red" }, { fontSizePt: -1 }, { verticalAlign: "top" }, { shadow: true }, null]) {
      let code = "none";
      try {
        doc.applyOps([{ type: "setRunFormat", range: range(id, 0, id, 4), format: format as never }], DIRECT);
      } catch (error) {
        code = isOfficeError(error) ? error.code : "other";
      }
      expect(code).toBe("invalid_argument");
    }
  });
});

describe("setParagraphStyle", () => {
  it("sets alignment, indents and spacing directly and in schema order", () => {
    const { doc, ids } = make(p(r("Clause"), '<w:keepNext/><w:rPr><w:b/></w:rPr>'));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [
        {
          type: "setParagraphStyle",
          blockId: id,
          style: { styleId: "Strong", alignment: "justify", indentLeftPt: 36, indentRightPt: 18, firstLineIndentPt: -18, spacingBeforePt: 6, spacingAfterPt: 12 },
        },
      ],
      DIRECT,
    );
    expect(blockXml(doc, id)).toContain(
      '<w:pPr><w:pStyle w:val="Strong"/><w:keepNext/><w:spacing w:before="120" w:after="240"/>' +
        '<w:ind w:left="720" w:right="360" w:hanging="360"/><w:jc w:val="both"/><w:rPr><w:b/></w:rPr></w:pPr>',
    );
    expect(block(doc, id).style).toMatchObject({
      styleId: "Strong",
      alignment: "justify",
      indentLeftPt: 36,
      indentRightPt: 18,
      firstLineIndentPt: -18,
      spacingBeforePt: 6,
      spacingAfterPt: 12,
    });
    expect(result.changedBlockIds).toEqual([id]);
    expect(result.results[0]?.caret).toBeNull();
  });

  it("applies and creates heading styles, and returns to the default style", async () => {
    const { doc, ids } = make(p(r("Title")) + p(r("Body"), '<w:pStyle w:val="Strong"/>'), undefined);
    const [title, body] = ids as [string, string];
    doc.applyOps(
      [
        { type: "setParagraphStyle", blockId: title, style: { headingLevel: 2, styleId: "Ignored" } },
        { type: "setParagraphStyle", blockId: body, style: { headingLevel: 0 } },
      ],
      DIRECT,
    );
    expect(block(doc, title).style).toMatchObject({ headingLevel: 2, styleName: "Heading 2", styleId: "Heading2" });
    expect(blockXml(doc, body)).toBe('<w:p><w:r><w:t xml:space="preserve">Body</w:t></w:r></w:p>');
    expect(doc.getOutline()).toEqual([{ blockId: title, level: 2, text: "Title", numberingLabel: null }]);
    const again = await reopen(doc);
    expect(again.getOutline().map((item) => [item.level, item.text])).toEqual([[2, "Title"]]);
    expect(await again.package.getPartText("/word/styles.xml")).toContain('<w:name w:val="heading 2"/>');
  });

  it("records the previous properties in w:pPrChange", () => {
    const { doc, ids } = make(p(r("Clause"), '<w:jc w:val="left"/><w:rPr><w:b/></w:rPr>'));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "setParagraphStyle", blockId: id, style: { alignment: "center" } }], TRACKED);
    expect(blockXml(doc, id)).toContain(
      `<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr><w:pPrChange w:id="1" w:author="${RAE}" w:date="${DATE}"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>`,
    );
    const revisions = doc.listRevisions();
    expect(revisions[0]).toMatchObject({
      kind: "format",
      scope: "paragraphFormat",
      blockIds: [id],
      range: null,
      formatChange: { before: { alignment: "left" }, after: { alignment: "center" } },
    });
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(block(doc, id).formatRevision?.kind).toBe("format");
    const snapshot = doc.snapshot();
    doc.rejectRevisions("all");
    expect(blockXml(doc, id)).toContain('<w:pPr><w:jc w:val="left"/><w:rPr><w:b/></w:rPr></w:pPr>');
    doc.restore(snapshot);
    doc.acceptRevisions("all");
    expect(blockXml(doc, id)).toContain('<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>');
  });

  it("records a change on a paragraph without properties, and nothing when nothing changes", () => {
    const { doc, ids } = make(p(r("Plain")) + p(r("Centred"), '<w:jc w:val="center"/>'));
    const [plain, centred] = ids as [string, string];
    const none = doc.applyOps([{ type: "setParagraphStyle", blockId: centred, style: { alignment: "center" } }], TRACKED);
    expect(none.revisionIds).toEqual([]);
    expect(none.changedBlockIds).toEqual([]);
    doc.applyOps([{ type: "setParagraphStyle", blockId: plain, style: { spacingAfterPt: 10 } }], TRACKED);
    expect(blockXml(doc, plain)).toMatch(/<w:pPr><w:spacing w:after="200"\/><w:pPrChange [^>]*><w:pPr\/><\/w:pPrChange><\/w:pPr>/);
    doc.rejectRevisions("all");
    expect(blockXml(doc, plain)).toBe('<w:p><w:r><w:t xml:space="preserve">Plain</w:t></w:r></w:p>');
  });

  it("rejects unknown styles, wrong blocks and malformed patches, and changes nothing", () => {
    const { doc, ids } = make(p(r("Clause")));
    const id = ids[0] as string;
    const before = bodyXml(doc);
    const code = (op: unknown): string => {
      try {
        doc.applyOps([op as never], TRACKED);
      } catch (error) {
        return isOfficeError(error) ? error.code : "other";
      }
      return "none";
    };
    expect(code({ type: "setParagraphStyle", blockId: id, style: { styleId: "Missing" } })).toBe("invalid_operation");
    expect(code({ type: "setParagraphStyle", blockId: id, style: { styleId: "Emphasis" } })).toBe("invalid_operation");
    expect(code({ type: "setParagraphStyle", blockId: id, style: { headingLevel: 12 } })).toBe("invalid_argument");
    expect(code({ type: "setParagraphStyle", blockId: id, style: { alignment: "middle" } })).toBe("invalid_argument");
    expect(code({ type: "setParagraphStyle", blockId: id, style: { spacingAfterPt: -3 } })).toBe("invalid_argument");
    expect(code({ type: "setParagraphStyle", blockId: "missing", style: {} })).toBe("stale_reference");
    expect(bodyXml(doc)).toEqual(before);
    expect(doc.listRevisions()).toEqual([]);
  });
});
