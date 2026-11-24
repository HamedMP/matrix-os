// Guards the committed office fixtures: every file exists, stays small, unzips into a
// package with the expected main part, and has the expected/ oracle files that engine
// tests compare against. Python is never needed to run this suite.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const MAX_BYTES = 200 * 1024;

const DOCX = [
  "basic", "numbering", "table", "comments", "footnotes-headers", "tracked",
  "links-fields", "contract", "contract-v2", "unicode",
];
const XLSX = ["basic", "formulas", "formats", "multi-sheet", "model"];

function unzip(name: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(join(DIR, name))));
}

function expected(name: string): string {
  return readFileSync(join(DIR, "expected", name), "utf8");
}

describe("office fixtures", () => {
  it.each([...DOCX.map((n) => `${n}.docx`), ...XLSX.map((n) => `${n}.xlsx`), "data.csv"])(
    "%s exists and is under 200 KB",
    (name) => {
      const size = statSync(join(DIR, name)).size;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(MAX_BYTES);
    },
  );

  it.each(DOCX)("%s.docx is a Word package with a summary and text oracle", (stem) => {
    const parts = unzip(`${stem}.docx`);
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]));
    expect(strFromU8(parts["word/document.xml"])).toContain("<w:body>");
    const summary = JSON.parse(expected(`${stem}.docx.summary.json`));
    expect(summary).toMatchObject({ file: `${stem}.docx`, valid: true });
    expect(expected(`${stem}.docx.txt`).length).toBeGreaterThan(0);
  });

  it.each(XLSX)("%s.xlsx is a spreadsheet package with shared strings and a summary", (stem) => {
    const parts = unzip(`${stem}.xlsx`);
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/sharedStrings.xml"]));
    const summary = JSON.parse(expected(`${stem}.xlsx.summary.json`));
    expect(summary).toMatchObject({ file: `${stem}.xlsx`, valid: true });
    for (const sheet of summary.sheets) expect(sheet.formulasWithoutCachedValue).toBe(0);
  });

  it("tracked.docx carries two authors' insertions, deletions, moves and formatting changes", () => {
    const xml = strFromU8(unzip("tracked.docx")["word/document.xml"]);
    for (const tag of ["<w:ins ", "<w:del ", "<w:moveFrom ", "<w:moveTo ", "<w:rPrChange ", "<w:pPrChange "]) {
      expect(xml).toContain(tag);
    }
    const summary = JSON.parse(expected("tracked.docx.summary.json"));
    expect(Object.keys(summary.revisions.byAuthor)).toEqual(["Alex Morgan", "Priya Shah"]);
    expect(expected("tracked.docx.txt")).toContain("within fifteen business days");
    expect(expected("tracked.docx.reject.txt")).toContain("within ten business days");
  });

  it("contract-v2 differs from contract by the recorded edits", () => {
    const v1 = expected("contract.docx.txt");
    const v2 = expected("contract-v2.docx.txt");
    const edits = JSON.parse(expected("contract-edits.json")) as Array<{ op: string; old?: string; new?: string }>;
    expect(edits.length).toBeGreaterThanOrEqual(10);
    for (const edit of edits.filter((e) => e.op === "replace")) {
      expect(v1).toContain(edit.old);
      expect(v2).toContain(edit.new);
    }
    expect(v1).toMatch(/“Charges” means/);
  });

  it("model.xlsx keeps a hard-coded total that disagrees with its projection", () => {
    const summary = JSON.parse(expected("model.xlsx.summary.json"));
    const projection = summary.sheets.find((s: { name: string }) => s.name === "Projection");
    const total = projection.formulas.find((f: { cell: string }) => f.cell === "N4");
    expect(total.formula).toBe("SUM(B4:M4)");
    expect(Math.round(Number(total.cached))).not.toBe(725000);
  });

  it("data.csv has a header and quoted fields", () => {
    const csv = readFileSync(join(DIR, "data.csv"), "utf8");
    expect(csv.split("\n")[0]).toBe("id,name,email,signup_date,plan,amount,notes");
    expect(csv).toContain('"Asked about ""team"" pricing"');
  });
});
