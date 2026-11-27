import { describe, expect, it } from "vitest";

import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { p, r } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, blockXml, build, paragraphs, reopen, text } from "./helpers.js";

const LINK =
  '<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the terms</w:t></w:r></w:hyperlink>';
const FIELD =
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>23 November</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
const INS = (author: string, content: string, id = "900"): string =>
  `<w:ins w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z">${content}</w:ins>`;
const DEL = (author: string, textValue: string, id = "901"): string =>
  `<w:del w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${textValue}</w:delText></w:r></w:del>`;

function one(body: string) {
  const doc = build({ body, links: { rIdLink: "https://example.com/terms" } });
  const block = paragraphs(doc)[0];
  if (block === undefined) throw new Error("no paragraph");
  return { doc, id: block.id };
}

describe("insertText, direct", () => {
  it("inserts inside a run and keeps its formatting", () => {
    const { doc, id } = one(p(r("Hello world", "<w:b/>")));
    const result = doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 6 }, text: "brave " }], DIRECT);
    expect(text(doc)).toBe("Hello brave world\n");
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">brave </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">world</w:t></w:r></w:p>',
    );
    expect(result.results[0]).toEqual({
      type: "insertText",
      revisionIds: [],
      createdBlockIds: [],
      commentId: null,
      caret: { blockId: id, offset: 12 },
    });
    expect(doc.listRevisions()).toEqual([]);
  });

  it("takes the formatting of the run before the position at a run boundary", () => {
    const { doc, id } = one(p(r("bold", "<w:b/>") + r(" plain")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 4 }, text: "er" }], DIRECT);
    const runs = doc.getBlock(id);
    if (runs?.type !== "paragraph") throw new Error("not a paragraph");
    expect(runs.runs.map((run) => [run.text, run.bold])).toEqual([
      ["bolder", true],
      [" plain", false],
    ]);
  });

  it("uses the run after the position at the start of a paragraph, and the mark in an empty one", () => {
    const { doc, id } = one(p(r("text", "<w:i/>")) + p("", "<w:rPr><w:b/></w:rPr>"));
    const second = paragraphs(doc)[1]?.id as string;
    doc.applyOps(
      [
        { type: "insertText", at: { blockId: id, offset: 0 }, text: "A " },
        { type: "insertText", at: { blockId: second, offset: 0 }, text: "typed" },
      ],
      DIRECT,
    );
    expect(blockXml(doc, id)).toContain('<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">A </w:t></w:r>');
    expect(blockXml(doc, second)).toContain("<w:r><w:rPr><w:b/></w:rPr><w:t>typed</w:t></w:r>");
  });

  it("writes tabs and line breaks as elements and keeps spaces", () => {
    const { doc, id } = one(p(r("ab")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 1 }, text: " x\ty\n z " }], DIRECT);
    expect(blockXml(doc, id)).toContain(
      '<w:r><w:t xml:space="preserve"> x</w:t><w:tab/><w:t>y</w:t><w:br/><w:t xml:space="preserve"> z </w:t></w:r>',
    );
    const block = doc.getBlock(id);
    expect(block?.type === "paragraph" && block.text).toBe("a x\ty\n z b");
  });

  it("applies direct formatting on top of the inherited formatting", () => {
    const { doc, id } = one(p(r("bold", "<w:b/>")));
    doc.applyOps(
      [{ type: "insertText", at: { blockId: id, offset: 4 }, text: "!", format: { bold: false, italic: true, color: "#ff0000" } }],
      DIRECT,
    );
    const block = doc.getBlock(id);
    if (block?.type !== "paragraph") throw new Error("not a paragraph");
    const last = block.runs[block.runs.length - 1];
    expect([last?.text, last?.bold, last?.italic, last?.color]).toEqual(["!", false, true, "#ff0000"]);
  });

  it("keeps text typed behind a link or a field result out of the link and the field", () => {
    const { doc, id } = one(p(r("See ") + LINK + r(" and ") + FIELD + r(".")));
    const block = doc.getBlock(id);
    if (block?.type !== "paragraph") throw new Error("not a paragraph");
    const afterLink = "See the terms".length;
    const afterField = block.text.indexOf("23 November") + "23 November".length;
    doc.applyOps(
      [
        { type: "insertText", at: { blockId: id, offset: afterField }, text: " 2026" },
        { type: "insertText", at: { blockId: id, offset: afterLink }, text: " here" },
      ],
      DIRECT,
    );
    const xml = blockXml(doc, id);
    expect(xml).toContain('</w:hyperlink><w:r><w:t xml:space="preserve"> here</w:t></w:r>');
    expect(xml).toContain('<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> 2026</w:t></w:r>');
    const after = doc.getBlock(id);
    if (after?.type !== "paragraph") throw new Error("not a paragraph");
    expect(after.runs.find((run) => run.text.includes("here"))?.hyperlink).toBeNull();
    expect(after.runs.find((run) => run.text.includes("2026"))?.field).toBeNull();
  });

  it("puts text typed inside a pending insertion or deletion outside the revision", () => {
    const { doc, id } = one(p(r("a") + INS("Alex Morgan", r("NEW")) + DEL("Alex Morgan", "OLD") + r("z")));
    doc.applyOps(
      [
        { type: "insertText", at: { blockId: id, offset: 5 }, text: "2" },
        { type: "insertText", at: { blockId: id, offset: 2 }, text: "1" },
      ],
      DIRECT,
    );
    expect(text(doc, "final")).toBe("aN1EW2z\n");
    expect(text(doc, "original")).toBe("a1O2LDz\n");
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([
      ["insert", "N"],
      ["insert", "EW"],
      ["delete", "O"],
      ["delete", "LD"],
    ]);
  });
});

describe("insertText, tracked", () => {
  it("wraps the new text in w:ins with id, author and date", () => {
    const { doc, id } = one(p(r("Hello world", "<w:b/>")));
    const result = doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 6 }, text: "brave " }], TRACKED);
    expect(blockXml(doc, id)).toBe(
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r>' +
        `<w:ins w:id="1" w:author="${RAE}" w:date="${DATE}"><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">brave </w:t></w:r></w:ins>` +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">world</w:t></w:r></w:p>',
    );
    expect(text(doc, "final")).toBe("Hello brave world\n");
    expect(text(doc, "original")).toBe("Hello world\n");
    const revisions = doc.listRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      kind: "insert",
      scope: "text",
      author: RAE,
      date: DATE,
      text: "brave ",
      blockIds: [id],
      range: { start: { blockId: id, offset: 6 }, end: { blockId: id, offset: 12 } },
    });
    expect(result.revisionIds).toEqual([revisions[0]?.id]);
    expect(result.results[0]?.caret).toEqual({ blockId: id, offset: 12 });
  });

  it("extends an insertion of the same author instead of starting a new one", () => {
    const { doc, id } = one(p(r("ab")));
    const first = doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 1 }, text: "12" }], TRACKED);
    const later = { ...TRACKED, date: "2026-11-24T08:00:00Z" };
    const inside = doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 2 }, text: "x" }], later);
    const atEnd = doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 4 }, text: "3" }], later);
    const atStart = doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 1 }, text: "0" }], later);
    expect(blockXml(doc, id).match(/<w:ins /g)).toHaveLength(1);
    expect(text(doc, "final")).toBe("a01x23b\n");
    expect(doc.listRevisions()).toHaveLength(1);
    expect(doc.listRevisions()[0]).toMatchObject({ text: "01x23", date: DATE });
    for (const result of [inside, atEnd, atStart]) expect(result.revisionIds).toEqual(first.revisionIds);
  });

  it("cuts an insertion of another author in two and puts its own between", () => {
    const { doc, id } = one(p(r("a") + INS("Alex Morgan", r("NEW")) + r("z")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 2 }, text: "!" }], TRACKED);
    const xml = blockXml(doc, id);
    expect(xml).toMatch(
      /<w:ins w:id="900" w:author="Alex Morgan"[^>]*><w:r><w:t xml:space="preserve">N<\/w:t><\/w:r><\/w:ins><w:ins w:id="\d+" w:author="Rae Okafor"[^>]*><w:r><w:t>!<\/w:t><\/w:r><\/w:ins><w:ins w:id="\d+" w:author="Alex Morgan"/,
    );
    expect(doc.listRevisions().map((revision) => [revision.author, revision.text])).toEqual([
      ["Alex Morgan", "N"],
      [RAE, "!"],
      ["Alex Morgan", "EW"],
    ]);
    expect(text(doc, "final")).toBe("aN!EWz\n");
    expect(text(doc, "original")).toBe("az\n");
  });

  it("never leaves new text inside a deletion", () => {
    const { doc, id } = one(p(r("a") + DEL("Alex Morgan", "OLD") + r("z")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 2 }, text: "new" }], TRACKED);
    expect(text(doc, "final")).toBe("anewz\n");
    expect(text(doc, "original")).toBe("aOLDz\n");
    expect(blockXml(doc, id)).not.toMatch(/<w:del [^>]*>(?:(?!<\/w:del>).)*<w:ins/);
  });

  it("keeps an insertion at the end of a link outside the link", () => {
    const { doc, id } = one(p(r("See ") + LINK + r(".")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: "See the terms".length }, text: " now" }], TRACKED);
    expect(blockXml(doc, id)).toMatch(/<\/w:hyperlink><w:ins [^>]*><w:r><w:t xml:space="preserve"> now<\/w:t><\/w:r><\/w:ins>/);
  });

  it("survives a save and reopen with the same revisions", async () => {
    const { doc, id } = one(p(r("Hello world")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 5 }, text: ",\tdear" }], TRACKED);
    const again = await reopen(doc);
    expect(text(again, "final")).toBe("Hello,\tdear world\n");
    expect(again.listRevisions().map((revision) => [revision.kind, revision.author, revision.date, revision.text])).toEqual([
      ["insert", RAE, DATE, ",\tdear"],
    ]);
  });
});

describe("insertText, validation", () => {
  it("rejects control characters, bad positions and bad formats without changing the document", () => {
    const { doc, id } = one(p(r("Hello")));
    const before = blockXml(doc, id);
    const attempt = (op: unknown): string => {
      try {
        doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 1 }, text: "fine" }, op as never], TRACKED);
      } catch (error) {
        expect(blockXml(doc, id)).toBe(before);
        expect(doc.listRevisions()).toEqual([]);
        return isOfficeError(error) ? error.code : "other";
      }
      return "no error";
    };
    expect(attempt({ type: "insertText", at: { blockId: id, offset: 0 }, text: "a\u0007b" })).toBe("invalid_argument");
    expect(attempt({ type: "insertText", at: { blockId: id, offset: 0 }, text: "a\rb" })).toBe("invalid_argument");
    expect(attempt({ type: "insertText", at: { blockId: id, offset: 0 }, text: 5 })).toBe("invalid_argument");
    expect(attempt({ type: "insertText", at: { blockId: id, offset: 99 }, text: "x" })).toBe("stale_reference");
    expect(attempt({ type: "insertText", at: { blockId: "nope", offset: 0 }, text: "x" })).toBe("stale_reference");
    expect(attempt({ type: "insertText", at: { blockId: id }, text: "x" })).toBe("invalid_argument");
    expect(attempt({ type: "insertText", at: { blockId: id, offset: 0 }, text: "x", format: { color: "red" } })).toBe(
      "invalid_argument",
    );
    expect(attempt({ type: "typeFaster" })).toBe("invalid_argument");
  });
});

describe("text that XML cannot hold", () => {
  // Each would stay in the model but be dropped by the writer, so the saved document would read back differently.
  const unwritable = ["a￾b", "a￿b", "a\uD800b", "a\uDC00b", "end\uD83D", "a\u000Bb", "a\u001Fb"];

  it.each(unwritable)("insertText, replaceRange and a new paragraph refuse %j", (value) => {
    const { doc, id } = one(p(r("Hello")));
    const before = blockXml(doc, id);
    const ops = [
      { type: "insertText", at: { blockId: id, offset: 0 }, text: value },
      { type: "replaceRange", range: { start: { blockId: id, offset: 0 }, end: { blockId: id, offset: 5 } }, text: value },
      { type: "insertParagraphAfter", blockId: id, text: value },
    ];
    for (const op of ops) {
      let failure: unknown = null;
      try {
        doc.applyOps([op as never], DIRECT);
      } catch (error) {
        failure = error;
      }
      expect(isOfficeError(failure) ? failure.code : failure).toBe("invalid_argument");
      expect(blockXml(doc, id)).toBe(before);
    }
  });

  it("still accepts a surrogate pair, tab and line feed, and saves them as written", async () => {
    const { doc, id } = one(p(r("Hello")));
    doc.applyOps([{ type: "insertText", at: { blockId: id, offset: 5 }, text: " \u{1F600}\tok\nnext" }], DIRECT);
    expect(text(await reopen(doc))).toBe(text(doc));
  });
});
