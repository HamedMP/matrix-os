import { describe, expect, it } from "vitest";

import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { p, r } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, bodyXml, build, paragraphs, text } from "./helpers.js";

const LINK =
  '<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the terms</w:t></w:r></w:hyperlink>';

function make(body: string): { doc: DocxDocument; ids: string[] } {
  const doc = build({ body, links: { rIdLink: "https://example.com/terms" } });
  return { doc, ids: paragraphs(doc).map((block) => block.id) };
}

const range = (a: string, from: number, b: string, to: number) => ({
  start: { blockId: a, offset: from },
  end: { blockId: b, offset: to },
});

describe("replaceRange, whole", () => {
  it("replaces text directly with the formatting of the replaced text", () => {
    const { doc, ids } = make(p(r("Pay within ") + r("30 days", "<w:b/>") + r(" of invoice.")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "replaceRange", range: range(id, 11, id, 18), text: "45 days" }], DIRECT);
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:t xml:space="preserve">Pay within </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>45 days</w:t></w:r>' +
        '<w:r><w:t xml:space="preserve"> of invoice.</w:t></w:r></w:p>',
    );
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 18 });
    expect(result.revisionIds).toEqual([]);
  });

  it("records a deletion followed by an insertion that name each other", () => {
    const { doc, ids } = make(p(r("Pay within ") + r("30 days", "<w:b/>") + r(" of invoice.")));
    const id = ids[0] as string;
    const result = doc.applyOps([{ type: "replaceRange", range: range(id, 11, id, 13), text: "45" }], TRACKED);
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:t xml:space="preserve">Pay within </w:t></w:r>' +
        `<w:del w:id="1" w:author="${RAE}" w:date="${DATE}"><w:r><w:rPr><w:b/></w:rPr><w:delText xml:space="preserve">30</w:delText></w:r></w:del>` +
        `<w:ins w:id="2" w:author="${RAE}" w:date="${DATE}"><w:r><w:rPr><w:b/></w:rPr><w:t>45</w:t></w:r></w:ins>` +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> days</w:t></w:r><w:r><w:t xml:space="preserve"> of invoice.</w:t></w:r></w:p>',
    );
    const [deletion, insertion] = doc.listRevisions();
    expect(deletion).toMatchObject({ kind: "delete", text: "30", pairedWith: insertion?.id });
    expect(insertion).toMatchObject({ kind: "insert", text: "45", pairedWith: deletion?.id });
    expect(result.results[0]?.revisionIds).toEqual([deletion?.id, insertion?.id]);
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 15 });
    expect(text(doc, "final")).toBe("Pay within 45 days of invoice.\n");
    expect(text(doc, "original")).toBe("Pay within 30 days of invoice.\n");
  });

  it("is a plain insertion for an empty range and a plain deletion for empty text", () => {
    const { doc, ids } = make(p(r("abcdef")));
    const id = ids[0] as string;
    doc.applyOps(
      [
        { type: "replaceRange", range: range(id, 4, id, 6), text: "" },
        { type: "replaceRange", range: range(id, 1, id, 1), text: "X" },
      ],
      TRACKED,
    );
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text, revision.pairedWith])).toEqual([
      ["insert", "X", null],
      ["delete", "ef", null],
    ]);
  });

  it("replaces across paragraphs: the new text follows the deleted text", () => {
    const { doc, ids } = make(p(r("First paragraph")) + p(r("Second paragraph")));
    const [first, second] = ids as [string, string];
    doc.applyOps([{ type: "replaceRange", range: range(first, 6, second, 7), text: "and only " }], TRACKED);
    expect(text(doc, "final")).toBe("First and only paragraph\n");
    expect(text(doc, "original")).toBe("First paragraph\nSecond paragraph\n");
    const direct = make(p(r("First paragraph")) + p(r("Second paragraph")));
    const [a, b] = direct.ids as [string, string];
    const result = direct.doc.applyOps([{ type: "replaceRange", range: range(a, 6, b, 7), text: "and only " }], DIRECT);
    expect(text(direct.doc)).toBe("First and only paragraph\n");
    expect(bodyXml(direct.doc)).toHaveLength(1);
    expect(result.removedBlockIds).toEqual([b]);
  });

  it("drops the link style when the whole link text is replaced", () => {
    const { doc, ids } = make(p(r("See ") + LINK + r(".")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "replaceRange", range: range(id, 4, id, 13), text: "clause 4" }], TRACKED);
    const xml = blockXml(doc, id);
    expect(xml).toMatch(/<\/w:hyperlink><w:ins [^>]*><w:r><w:t>clause 4<\/w:t><\/w:r><\/w:ins>/);
    expect(text(doc, "final")).toBe("See clause 4.\n");
  });
});

describe("replaceRange, word by word", () => {
  it("marks only the words that differ and leaves the rest untouched", () => {
    const { doc, ids } = make(p(r("The term is ") + r("24 months", "<w:b/>") + r(" from the start date.")));
    const id = ids[0] as string;
    const block = doc.getBlock(id);
    if (block?.type !== "paragraph") throw new Error("not a paragraph");
    const result = doc.applyOps(
      [
        {
          type: "replaceRange",
          range: range(id, 0, id, block.text.length),
          text: "The term is 36 months from the effective date.",
          granularity: "words",
        },
      ],
      TRACKED,
    );
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["delete", "24"],
      ["insert", "36"],
      ["delete", "start"],
      ["insert", "effective"],
    ]);
    expect(text(doc, "final")).toBe("The term is 36 months from the effective date.\n");
    expect(text(doc, "original")).toBe("The term is 24 months from the start date.\n");
    const after = doc.getBlock(id);
    if (after?.type !== "paragraph") throw new Error("not a paragraph");
    // The replacement of a bold word is bold; unchanged words keep their runs.
    expect(after.runs.find((run) => run.text === "36")?.bold).toBe(true);
    expect(after.runs.find((run) => run.text === "effective")?.bold).toBe(false);
    expect(blockXml(doc, id)).toContain('<w:r><w:t xml:space="preserve">The term is </w:t></w:r>');
    expect(result.results[0]?.revisionIds).toHaveLength(4);
  });

  it("changes nothing when the text is the same", () => {
    const { doc, ids } = make(p(r("Same text here")));
    const id = ids[0] as string;
    const before = blockXml(doc, id);
    const result = doc.applyOps([{ type: "replaceRange", range: range(id, 0, id, 14), text: "Same text here", granularity: "words" }], TRACKED);
    expect(blockXml(doc, id)).toBe(before);
    expect(result.revisionIds).toEqual([]);
    expect(result.changedBlockIds).toEqual([]);
  });

  it("compares against the visible text when the range already holds revisions", () => {
    const { doc, ids } = make(p(r("alpha beta gamma")));
    const id = ids[0] as string;
    doc.applyOps([{ type: "replaceRange", range: range(id, 6, id, 10), text: "BETA" }], { ...TRACKED, author: "Alex Morgan" });
    expect(text(doc, "final")).toBe("alpha BETA gamma\n");
    const block = doc.getBlock(id);
    if (block?.type !== "paragraph") throw new Error("not a paragraph");
    doc.applyOps(
      [{ type: "replaceRange", range: range(id, 0, id, block.text.length), text: "alpha BETA delta", granularity: "words" }],
      TRACKED,
    );
    expect(text(doc, "final")).toBe("alpha BETA delta\n");
    expect(text(doc, "original")).toBe("alpha beta gamma\n");
    expect(doc.listRevisions().filter((revision) => revision.author === RAE).map((revision) => [revision.kind, revision.text])).toEqual([
      ["delete", "gamma"],
      ["insert", "delta"],
    ]);
  });

  it("works directly, and puts the caret behind text added at the end", () => {
    const { doc, ids } = make(p(r("one two three")));
    const id = ids[0] as string;
    const result = doc.applyOps(
      [{ type: "replaceRange", range: range(id, 0, id, 13), text: "one 2 three four", granularity: "words" }],
      DIRECT,
    );
    expect(text(doc)).toBe("one 2 three four\n");
    expect(doc.listRevisions()).toEqual([]);
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 16 });
  });

  it("needs a range inside one paragraph", () => {
    const { doc, ids } = make(p(r("one")) + p(r("two")));
    const [a, b] = ids as [string, string];
    let code = "none";
    try {
      doc.applyOps([{ type: "replaceRange", range: range(a, 0, b, 1), text: "x", granularity: "words" }], TRACKED);
    } catch (error) {
      code = isOfficeError(error) ? error.code : "other";
    }
    expect(code).toBe("invalid_argument");
    expect(text(doc, "markup")).toBe("one\ntwo\n");
  });
});
