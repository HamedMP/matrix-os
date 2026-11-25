import { describe, expect, it } from "vitest";

import type { DocxModule, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import * as docx from "../../../../packages/office/src/docx/index.js";
import { createDocx, openDocx } from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";

const paragraphs = (doc: { getView(): { body: { blocks: unknown[] } } }): ParagraphBlock[] =>
  doc.getView().body.blocks.filter((block): block is ParagraphBlock => (block as ParagraphBlock).type === "paragraph");

async function partText(doc: ReturnType<typeof createDocx>, name: string): Promise<string> {
  return doc.package.getPartText(name);
}

function expectOfficeError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(isOfficeError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected OfficeError ${code}`);
}

describe("createDocx", () => {
  it("satisfies the module contract", () => {
    const contract: DocxModule = docx;
    expect(typeof contract.createDocx).toBe("function");
  });

  it("creates a blank A4 document with one empty paragraph that survives save and reopen", async () => {
    const doc = createDocx();
    const view = doc.getView();
    expect(paragraphs(doc)).toHaveLength(1);
    expect(paragraphs(doc)[0]?.text).toBe("");
    expect(view.sections).toHaveLength(1);
    const section = view.sections[0];
    expect(section?.orientation).toBe("portrait");
    expect(section?.pageWidthPt).toBeCloseTo(595.3, 1);
    expect(section?.pageHeightPt).toBeCloseTo(841.9, 1);
    expect(section?.marginLeftPt).toBe(72);
    expect(doc.getProperties()).toEqual({ title: null, creator: null, lastModifiedBy: null, created: null, modified: null });
    expect(doc.getTrackRevisions()).toBe(false);

    const reopened = await openDocx(await doc.save());
    expect(reopened.getPlainText()).toBe("\n");
    expect(reopened.package.hasPart("/docProps/app.xml")).toBe(true);
  });

  it("stores title, author and date as core properties", async () => {
    const doc = createDocx({ title: "Q4 <Plan> & \"notes\"", author: "Dana Reyes", date: "2026-11-23T10:00:00Z" });
    const expected = {
      title: 'Q4 <Plan> & "notes"',
      creator: "Dana Reyes",
      lastModifiedBy: "Dana Reyes",
      created: "2026-11-23T10:00:00Z",
      modified: "2026-11-23T10:00:00Z",
    };
    expect(doc.getProperties()).toEqual(expected);
    expect((await openDocx(await doc.save())).getProperties()).toEqual(expected);
  });

  it("defines the built-in styles, Table Grid and both list definitions", async () => {
    const doc = createDocx();
    const styles = await partText(doc, "/word/styles.xml");
    for (const id of ["Normal", "Title", "ListParagraph", "TableGrid", "Quote", "Hyperlink"]) {
      expect(styles).toContain(`w:styleId="${id}"`);
    }
    for (let level = 1; level <= 9; level++) expect(styles).toContain(`w:styleId="Heading${level}"`);
    const numbering = await partText(doc, "/word/numbering.xml");
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>');
    expect(numbering).toContain('<w:lvlText w:val="%1.%2.%3."/>');
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');
    expect(numbering).toMatch(/<w:num w:numId="1">.*<w:num w:numId="2">/);
    expect(await partText(doc, "/word/settings.xml")).toContain("w:defaultTabStop");
  });

  it("writes plain paragraphs with tabs, line breaks and paragraph properties", async () => {
    const doc = createDocx({
      paragraphs: [
        { text: "Annual report", style: { styleId: "Title" } },
        { text: "Overview", style: { headingLevel: 1 } },
        { text: "Details", style: { headingLevel: 3 } },
        "Name\tValue\nsecond line",
        { text: "Centred", style: { alignment: "center", indentLeftPt: 36, firstLineIndentPt: -18, spacingAfterPt: 6 } },
      ],
    });
    const reopened = await openDocx(await doc.save());
    const blocks = paragraphs(reopened);
    expect(blocks.map((block) => block.text)).toEqual([
      "Annual report",
      "Overview",
      "Details",
      "Name\tValue\nsecond line",
      "Centred",
    ]);
    expect(blocks[0]?.style.styleName).toBe("Title");
    expect(blocks[1]?.style.headingLevel).toBe(1);
    expect(blocks[1]?.style.styleName).toBe("Heading 1");
    expect(blocks[2]?.style.headingLevel).toBe(3);
    expect(blocks[3]?.style.styleId).toBe("Normal");
    const centred = blocks[4]?.style;
    expect(centred?.alignment).toBe("center");
    expect(centred?.indentLeftPt).toBe(36);
    expect(centred?.firstLineIndentPt).toBe(-18);
    expect(centred?.spacingAfterPt).toBe(6);
    expect(reopened.getOutline().map((item) => [item.level, item.text])).toEqual([
      [1, "Overview"],
      [3, "Details"],
    ]);
  });

  it("keeps hostile text as literal text", async () => {
    const hostile = '<script>alert("x")</script> & </w:t><w:t>';
    const doc = await openDocx(await createDocx({ paragraphs: [hostile] }).save());
    expect(doc.getPlainText()).toBe(`${hostile}\n`);
  });

  it("rejects control characters, unknown styles and malformed options", () => {
    expectOfficeError(() => createDocx({ paragraphs: ["bad\u0007bell"] }), "invalid_argument");
    expectOfficeError(() => createDocx({ paragraphs: [{ text: "x", style: { styleId: "NoSuchStyle" } }] }), "invalid_operation");
    expectOfficeError(() => createDocx({ paragraphs: [{ text: "x", style: { headingLevel: 12 } }] }), "invalid_argument");
    expectOfficeError(() => createDocx({ paragraphs: [{ text: "x", style: { indentLeftPt: Number.NaN } }] }), "invalid_argument");
    expectOfficeError(() => createDocx({ date: "yesterday" }), "invalid_argument");
  });

  it("is deterministic: the same options give the same bytes", async () => {
    const options = { title: "Same", author: "A", date: "2026-01-01", paragraphs: ["one", "two"] };
    const first = await createDocx(options).save();
    const second = await createDocx(options).save();
    expect(first).toEqual(second);
  });

  it("gives the new document working revision tracking flags", async () => {
    const doc = createDocx({ paragraphs: ["x"] });
    doc.setTrackRevisions(true);
    expect((await openDocx(await doc.save())).getTrackRevisions()).toBe(true);
  });
});
