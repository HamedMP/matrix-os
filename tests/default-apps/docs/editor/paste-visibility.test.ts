// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ParagraphBlock } from "../../../../home/apps/_shared/office-engine/index";
import { createDocx, openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { ModelIndex, readClipboard } from "../../../../home/apps/docs/src/editor/index";
import { MAX_PASTE_CHARACTERS, cleanText, parseHtml, parsePlainText } from "../../../../home/apps/docs/src/editor/paste";
import { clipToVisible, stepSpans, visibleBounds, visibleSpans } from "../../../../home/apps/docs/src/editor/visibility";
import { OTHER, at, bodyParagraphs, bodyTables, cellParagraphs, fixtureBytes } from "./helpers";

const source = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? "" });
const texts = (paragraphs: Array<Array<{ text: string }>>): string[] => paragraphs.map((segments) => segments.map((segment) => segment.text).join(""));

describe("clipboard parsing", () => {
  it("splits plain text into paragraphs and cleans it", () => {
    expect(texts(parsePlainText("one\r\ntwo\rthree\n").paragraphs)).toEqual(["one", "two", "three", ""]);
    expect(cleanText("a\u0000b\u001Fc\td\ne￼\u007F")).toBe("abc\td\ne");
  });

  it("reads paragraphs, line breaks, table cells and inline formatting from HTML", () => {
    const parsed = parseHtml("<h1>Title</h1><p>one<br>two</p><ul><li>item <strong>strong</strong></li></ul><table><tr><td>a</td><td>b</td></tr></table>")!;
    expect(texts(parsed.paragraphs)).toEqual(["Title", "one\ntwo", "item strong", "a\tb"]);
    expect(parsed.formatted).toBe(true);
    expect(parsed.paragraphs[2]).toEqual([
      { text: "item ", bold: false, italic: false, underline: false },
      { text: "strong", bold: true, italic: false, underline: false },
    ]);
  });

  it("honours styles that turn formatting off and collapses white space like a browser", () => {
    const parsed = parseHtml('<b style="font-weight:normal"><span>  plain\n   text </span><span style="font-style:italic">slanted</span></b>')!;
    expect(parsed.paragraphs).toEqual([
      [
        { text: "plain text ", bold: false, italic: false, underline: false },
        { text: "slanted", bold: false, italic: true, underline: false },
      ],
    ]);
  });

  it("ignores scripts, styles and hidden content", () => {
    const parsed = parseHtml('<style>p{}</style><script>alert(1)</script><p>seen</p><p style="display:none">hidden</p>')!;
    expect(texts(parsed.paragraphs)).toEqual(["seen"]);
    expect(parseHtml("<script>x</script>")).toBeNull();
  });

  it("prefers plain text unless the HTML carries formatting", () => {
    expect(readClipboard(null)).toBeNull();
    expect(readClipboard(source({}))).toBeNull();
    expect(readClipboard(source({ "text/plain": "a\nb", "text/html": "<p>a</p><p>b</p>" }))).toEqual(parsePlainText("a\nb"));
    expect(readClipboard(source({ "text/plain": "a b", "text/html": "<p>a <i>b</i></p>" }))?.formatted).toBe(true);
    expect(texts(readClipboard(source({ "text/html": "<p>only html</p>" }))!.paragraphs)).toEqual(["only html"]);
    const broken = { getData: () => { throw new Error("denied"); } };
    expect(readClipboard(broken)).toBeNull();
  });
});

describe("clipboard size", () => {
  const big = "x".repeat(MAX_PASTE_CHARACTERS + 1);

  it("refuses text larger than a paste can insert whole, instead of keeping only its start", () => {
    expect(parsePlainText(big)).toBe("too-large");
    expect(parseHtml(`<p><b>${big}</b></p>`)).toBe("too-large");
    expect(readClipboard(source({ "text/plain": big }))).toBe("too-large");
    expect(readClipboard(source({ "text/html": `<p><i>${big}</i></p>` }))).toBe("too-large");
    // Formatted HTML that is too large falls back to plain text that fits.
    expect(readClipboard(source({ "text/plain": "short", "text/html": `<p><i>${big}</i></p>` }))).toEqual(parsePlainText("short"));
  });

  it("accepts text right at the limit whole", () => {
    const fits = parsePlainText(`${"y".repeat(MAX_PASTE_CHARACTERS - 2)}\nz`);
    expect(fits).not.toBe("too-large");
    expect(texts((fits as Exclude<typeof fits, "too-large">).paragraphs).map((line) => line.length)).toEqual([MAX_PASTE_CHARACTERS - 2, 1]);
  });
});

describe("visible text of a paragraph", () => {
  function tracked(): ParagraphBlock {
    const doc = createDocx({ paragraphs: ["Hello brave new world"] });
    const id = bodyParagraphs(doc)[0]!.id;
    doc.applyOps(
      [
        { type: "insertText", at: at(id, 21), text: "!!" },
        { type: "deleteRange", range: { start: at(id, 6), end: at(id, 12) } },
      ],
      { track: true, author: OTHER, date: "2026-11-20T09:00:00Z" },
    );
    return bodyParagraphs(doc)[0]!;
  }

  it("lists what each view shows", () => {
    const block = tracked();
    expect(block.text).toBe("Hello brave new world!!");
    expect(visibleSpans(block, "markup")).toEqual([{ start: 0, end: 23 }]);
    expect(visibleSpans(block, "final")).toEqual([
      { start: 0, end: 6 },
      { start: 12, end: 23 },
    ]);
    expect(visibleSpans(block, "original")).toEqual([{ start: 0, end: 21 }]);
    expect(visibleBounds(block, "original")).toEqual({ start: 0, end: 21 });
    expect(clipToVisible(block, "final", 3, 15)).toEqual([
      { start: 3, end: 6 },
      { start: 12, end: 15 },
    ]);
  });

  it("steps over hidden text by characters and words", () => {
    const block = tracked();
    // Final view, caret before "new": the character before it is the space at 5.
    expect(stepSpans(block, "final", 12, "backward", "character")).toEqual([{ start: 5, end: 6 }]);
    expect(stepSpans(block, "markup", 12, "backward", "character")).toEqual([{ start: 11, end: 12 }]);
    // A word delete in the final view takes "Hello " and nothing of the hidden text.
    expect(stepSpans(block, "final", 12, "backward", "word")).toEqual([{ start: 0, end: 6 }]);
    expect(stepSpans(block, "final", 4, "forward", "word")).toEqual([{ start: 4, end: 5 }]);
    // Forward from the space: the space and the next visible word, on both sides of the hidden text.
    expect(stepSpans(block, "final", 5, "forward", "word")).toEqual([
      { start: 5, end: 6 },
      { start: 12, end: 15 },
    ]);
    expect(stepSpans(block, "final", 0, "backward", "character")).toEqual([]);
    expect(stepSpans(block, "original", 21, "forward", "character")).toEqual([]);
    expect(stepSpans(block, "final", 23, "forward", "word")).toEqual([]);
  });
});

describe("model index", () => {
  it("orders paragraphs, knows their containers and splits ranges the engine would refuse", async () => {
    const doc = await openDocx(fixtureBytes("table.docx"));
    const index = ModelIndex.build(doc.getView());
    const [heading, intro, closing] = bodyParagraphs(doc);
    const table = bodyTables(doc)[0]!;
    const phase = cellParagraphs(table, 1, 0)[0]!;
    const owner = cellParagraphs(table, 1, 1)[0]!;
    const lengthOf = (id: string): number => (doc.getBlock(id) as ParagraphBlock).text.length;

    expect(index.entry(heading!.id)).toMatchObject({ order: 0, storyKind: "body", tableId: null });
    expect(index.entry(phase.id)).toMatchObject({ tableId: table.id });
    expect(index.compare(at(intro!.id, 3), at(phase.id, 0))).toBeLessThan(0);
    expect(index.compare(at(owner.id, 1), at(owner.id, 1))).toBe(0);
    expect(index.siblingBefore(closing!.id)).toEqual({ id: table.id, type: "table" });
    expect(index.siblingBefore(phase.id)).toBeNull();
    expect(index.isTable(table.id)).toBe(true);

    // Siblings: one range, the table between them included.
    const whole = { start: at(intro!.id, 2), end: at(closing!.id, 4) };
    expect(index.engineRanges(whole, lengthOf)).toEqual([whole]);
    // From the body into a cell: one range per run of sibling paragraphs, all valid for the engine.
    const ranges = index.engineRanges({ start: at(intro!.id, 2), end: at(owner.id, 3) }, lengthOf);
    expect(ranges[0]).toEqual({ start: at(intro!.id, 2), end: at(intro!.id, intro!.text.length) });
    expect(ranges.at(-1)).toEqual({ start: at(owner.id, 0), end: at(owner.id, 3) });
    for (const range of [...ranges].reverse()) {
      expect(() => doc.applyOps([{ type: "deleteRange", range }], { track: false, author: OTHER, date: "2026-11-20T09:00:00Z" })).not.toThrow();
    }
    expect(index.engineRanges({ start: at(owner.id, 3), end: at(intro!.id, 2) }, lengthOf)).toEqual([]);
    expect(index.engineRanges({ start: at("missing", 0), end: at(intro!.id, 2) }, lengthOf)).toEqual([]);
  });
});
