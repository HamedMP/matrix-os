import { describe, expect, it } from "vitest";

import type { DocxDocument, ParagraphBlock, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { createDocxFromMarkdown, openDocx, toMarkdown } from "../../../../packages/office/src/docx/index.js";
import { parseMarkdown } from "../../../../packages/office/src/docx/create/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";

const SAMPLE = `# Project plan

Intro with **bold**, *italic*, ~~old~~, \`code\` and [a link](https://example.com/terms).

## Steps

1. Gather requirements
2. Draft the design
   1. Data model
   2. Interfaces
3. Ship it

- Risks
  - Schedule
- Owners

> Keep the scope small.

| Name | Qty |
| --- | ---: |
| Apples | 3 |
| Pears | 5 |

\`\`\`
const x = 1 < 2;
\`\`\`
`;

async function roundTrip(markdown: string): Promise<DocxDocument> {
  return openDocx(await createDocxFromMarkdown(markdown, { title: "Plan" }).save());
}

const blocksOf = (doc: DocxDocument) => doc.getView().body.blocks;
const paragraph = (doc: DocxDocument, index: number): ParagraphBlock => blocksOf(doc)[index] as ParagraphBlock;

describe("createDocxFromMarkdown", () => {
  it("imports headings, inline formatting, lists, quotes, tables and code", async () => {
    const doc = await roundTrip(SAMPLE);
    const blocks = blocksOf(doc);
    const summary = blocks.map((block) =>
      block.type === "paragraph"
        ? [block.style.styleName, block.numbering?.text ?? null, block.text]
        : ["table", (block as TableBlock).rows.length],
    );
    expect(summary).toEqual([
      ["Heading 1", null, "Project plan"],
      ["Normal", null, "Intro with bold, italic, old, code and a link."],
      ["Heading 2", null, "Steps"],
      ["List Paragraph", "1.", "Gather requirements"],
      ["List Paragraph", "2.", "Draft the design"],
      ["List Paragraph", "2.1.", "Data model"],
      ["List Paragraph", "2.2.", "Interfaces"],
      ["List Paragraph", "3.", "Ship it"],
      ["List Paragraph", "•", "Risks"],
      ["List Paragraph", "◦", "Schedule"],
      ["List Paragraph", "•", "Owners"],
      ["Quote", null, "Keep the scope small."],
      ["table", 3],
      ["Code Block", null, "const x = 1 < 2;"],
    ]);
    const intro = paragraph(doc, 1).runs;
    const run = (text: string) => intro.find((candidate) => candidate.text === text);
    expect(run("bold")?.bold).toBe(true);
    expect(run("italic")?.italic).toBe(true);
    expect(run("old")?.strike).toBe(true);
    expect(run("code")?.fontFamily).toBe("Consolas");
    expect(run("a link")?.hyperlink?.href).toBe("https://example.com/terms");

    const table = blocks[12] as TableBlock;
    expect(table.rows[0]?.isHeader).toBe(true);
    const cellText = table.rows.map((row) => row.cells.map((cell) => (cell.blocks[0] as ParagraphBlock).text));
    expect(cellText).toEqual([
      ["Name", "Qty"],
      ["Apples", "3"],
      ["Pears", "5"],
    ]);
    expect((table.rows[1]?.cells[1]?.blocks[0] as ParagraphBlock).style.alignment).toBe("right");
    expect(doc.getProperties().title).toBe("Plan");
  });

  it("restarts every ordered list and honours its start number", async () => {
    const doc = await roundTrip("1. a\n2. b\n\nText between.\n\n3. c\n4. d\n\n5. still the same list\n\nMore text.\n\n1. e\n");
    const labels = blocksOf(doc)
      .filter((block): block is ParagraphBlock => block.type === "paragraph" && block.numbering !== null)
      .map((block) => `${block.numbering?.text} ${block.text}`);
    expect(labels).toEqual(["1. a", "2. b", "3. c", "4. d", "5. still the same list", "1. e"]);
  });

  it("round-trips its structure through toMarkdown", async () => {
    const first = await roundTrip(SAMPLE);
    const markdown = toMarkdown(first);
    const second = await roundTrip(markdown);
    const shape = (doc: DocxDocument) =>
      blocksOf(doc).map((block) =>
        block.type === "paragraph"
          ? {
              style: block.style.styleId,
              label: block.numbering?.text ?? null,
              text: block.text,
              bold: block.runs.filter((run) => run.bold).map((run) => run.text),
              links: block.runs.flatMap((run) => (run.hyperlink === null ? [] : [run.hyperlink.href])),
            }
          : { rows: (block as TableBlock).rows.map((row) => row.cells.length) },
      );
    expect(shape(second)).toEqual(shape(first));
    expect(toMarkdown(second)).toBe(markdown);
  });

  it("keeps raw HTML and hostile links as literal text", async () => {
    const doc = await roundTrip('<script>alert(1)</script>\n\n[click](javascript:alert(1)) and <img src=x onerror="y">\n');
    expect(paragraph(doc, 0).text).toBe("<script>alert(1)</script>");
    const second = paragraph(doc, 1);
    expect(second.text).toBe('click and <img src=x onerror="y">');
    expect(second.runs.every((run) => run.hyperlink === null)).toBe(true);
  });

  it("handles escapes, hard breaks, setext headings and nested emphasis", async () => {
    const doc = await roundTrip("Title\n=====\n\nA \\*literal\\* star  \nnext line and ***both*** here\n");
    expect(paragraph(doc, 0).style.headingLevel).toBe(1);
    const body = paragraph(doc, 1);
    expect(body.text).toBe("A *literal* star\nnext line and both here");
    const both = body.runs.find((run) => run.text === "both");
    expect(both?.bold).toBe(true);
    expect(both?.italic).toBe(true);
  });

  it("parses pathological emphasis input in linear time", () => {
    const started = performance.now();
    const parsed = parseMarkdown(`${"*a ".repeat(20_000)}${"[".repeat(20_000)}`, 3);
    expect(parsed.blocks).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses input above the size limit", () => {
    try {
      createDocxFromMarkdown("x".repeat(2_000_001));
      throw new Error("expected limit_exceeded");
    } catch (error) {
      expect(isOfficeError(error) && error.code === "limit_exceeded").toBe(true);
    }
  });
});
