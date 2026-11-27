import { describe, expect, it } from "vitest";
import type { XmlDocument, XmlElement, XmlText } from "../../../packages/office/src/api/xml.js";
import { find, findAll, parseXml, serializeXml, setAttr, setText } from "../../../packages/office/src/xml/index.js";
import { buildLargeDocument, buildLargeSheet } from "./corpus.js";

const FIVE_MEGABYTES = 5 * 1024 * 1024;

/** Best of several runs, so a busy machine does not fail the bound. */
function fastest<T>(runs: number, action: () => T): { result: T; milliseconds: number } {
  let best = Number.POSITIVE_INFINITY;
  let result = action();
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    result = action();
    best = Math.min(best, performance.now() - started);
  }
  return { result, milliseconds: best };
}

describe("large documents", () => {
  const sheet = buildLargeSheet(FIVE_MEGABYTES);
  const word = buildLargeDocument(FIVE_MEGABYTES);

  it("parses a 5 MB worksheet in well under a second", () => {
    expect(sheet.length).toBeGreaterThanOrEqual(FIVE_MEGABYTES);
    const { result, milliseconds } = fastest(3, () => parseXml(sheet));
    expect(milliseconds).toBeLessThan(1000);
    expect(result.root.name).toBe("worksheet");
  });

  it("parses a 5 MB WordprocessingML body in well under a second", () => {
    expect(word.length).toBeGreaterThanOrEqual(FIVE_MEGABYTES);
    const { result, milliseconds } = fastest(3, () => parseXml(word));
    expect(milliseconds).toBeLessThan(1000);
    expect(result.root.name).toBe("w:document");
  });

  it("writes a 5 MB document back exactly, in well under a second", () => {
    for (const source of [sheet, word]) {
      const doc: XmlDocument = parseXml(source);
      const { result, milliseconds } = fastest(3, () => serializeXml(doc));
      expect(milliseconds).toBeLessThan(1000);
      expect(result === source).toBe(true);
    }
  });

  it("changes only the edited cell in a large worksheet", () => {
    const doc = parseXml(sheet);
    const rows = findAll(doc, "row");
    expect(rows.length).toBeGreaterThan(10_000);
    const row = rows[rows.length - 5] as XmlElement;
    const cell = find(row, "c") as XmlElement;
    const value = find(cell, "v") as XmlElement;
    const before = serializeXml(cell);
    setAttr(cell, "t", "n");
    setText(value.children[0] as XmlText, "123456");
    const after = serializeXml(cell);
    expect(after).not.toBe(before);

    const output = serializeXml(doc);
    const at = sheet.lastIndexOf(before);
    expect(at).toBeGreaterThan(0);
    expect(output === sheet.slice(0, at) + after + sheet.slice(at + before.length)).toBe(true);
  });
});
