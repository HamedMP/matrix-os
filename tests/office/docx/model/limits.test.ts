import { describe, expect, it } from "vitest";

import type { ParagraphBlock, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { buildDocument, buildPackage, cell, p, r, row, tbl } from "./build.js";

describe("untrusted documents stay within bounds", () => {
  it("copes with fields that are opened and never closed", () => {
    const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>REF x </w:instrText></w:r>';
    const document = buildDocument({ body: p(r("before") + begin.repeat(500) + r("hidden")) + p(r("still hidden")) });
    const blocks = document.getView().body.blocks as ParagraphBlock[];
    expect(blocks.map((block) => block.text)).toEqual(["before", ""]);
    expect(document.getPlainText()).toBe("before\n\n");
    expect(document.getCrossReferences()).toEqual([]);
  });

  it("caps the length of a collected field code", () => {
    const code = `<w:r><w:instrText>${"A".repeat(1000)} </w:instrText></w:r>`;
    const document = buildDocument({
      body: p(`<w:r><w:fldChar w:fldCharType="begin"/></w:r>${code.repeat(20)}<w:r><w:fldChar w:fldCharType="separate"/></w:r>${r("result")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`),
    });
    const run = (document.getView().body.blocks[0] as ParagraphBlock).runs[0];
    expect(run?.text).toBe("result");
    expect(run?.field?.instruction.length).toBeLessThanOrEqual(5200);
  });

  it("builds deeply nested tables without running out of stack", () => {
    let content = p(r("core"));
    for (let depth = 0; depth < 100; depth++) content = tbl(row(cell(content + p(""))));
    const document = buildDocument({ body: content });
    let block = document.getView().body.blocks[0] as TableBlock | ParagraphBlock;
    let depth = 0;
    while (block.type === "table") {
      block = block.rows[0]!.cells[0]!.blocks[0] as TableBlock | ParagraphBlock;
      depth += 1;
    }
    expect(depth).toBe(100);
    expect(block.text).toBe("core");
    expect(document.getPlainText().startsWith("core\n")).toBe(true);
  });

  it("refuses XML that nests deeper than the parser allows", async () => {
    const deep = `${"<w:sdt><w:sdtContent>".repeat(300)}${p(r("x"))}${"</w:sdtContent></w:sdt>".repeat(300)}`;
    await expect(openDocx(await buildPackage({ body: deep }).pkg.save())).rejects.toSatisfy((error) =>
      isOfficeError(error, "limit_exceeded"),
    );
  });

  it("scans a paragraph built to make the text heuristics slow in bounded time", () => {
    const hostile = '(the "a") clauses 1, 2, 3 and 4 '.repeat(600);
    const long = "x".repeat(30_000);
    const document = buildDocument({ body: p(r(hostile)) + p(r(`"${long}" means nothing; see clause 1`)) });
    const started = performance.now();
    const terms = document.getDefinedTerms();
    const references = document.getCrossReferences();
    expect(performance.now() - started).toBeLessThan(3000);
    // The first 200 quoted stretches of one paragraph are examined; over-long paragraphs are skipped.
    expect(terms).toHaveLength(200);
    expect(references).toHaveLength(2400);
    expect(references.every((reference) => reference.broken)).toBe(true);
  });

  it("cuts the preview of a long cross-reference target at 240 characters", () => {
    const long = `1.\tStart ${"lorem ipsum ".repeat(40)}end`;
    const document = buildDocument({ body: p(r(long)) + p(r("As set out in clause 1.")) });
    const [reference] = document.getCrossReferences();
    expect(reference).toMatchObject({ text: "clause 1", targetLabel: "1.", broken: false });
    expect(reference?.targetText).toBe(long.slice(0, 240));
  });

  it("stops following a style chain and a numbering link that loop", () => {
    const style = (id: string, basedOn: string): string =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="${basedOn}"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>`;
    const document = buildDocument({
      styles: style("A", "B") + style("B", "A") + '<w:style w:type="numbering" w:styleId="L"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>',
      numbering: '<w:abstractNum w:abstractNumId="0"><w:numStyleLink w:val="L"/></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      body: p(r("looped"), '<w:pStyle w:val="A"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    });
    const block = document.getView().body.blocks[0] as ParagraphBlock;
    expect(block.style).toMatchObject({ styleId: "A", alignment: "center" });
    expect(block.numbering).toBeNull();
  });
});
