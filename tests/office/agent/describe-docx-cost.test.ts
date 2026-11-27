import { describe, expect, it, vi } from "vitest";

// Counts how often the cells of a row are listed: a description must not list a row once per cell.
vi.mock("../../../packages/office/src/docx/internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../packages/office/src/docx/internal.js")>();
  return { ...actual, rowCells: vi.fn(actual.rowCells) };
});

const { rowCells } = await import("../../../packages/office/src/docx/internal.js");
const { describeDocx } = await import("../../../packages/office/src/agent/index.js");
const { build } = await import("../docx/edit/helpers.js");
const { cell, p, r, row, tbl } = await import("../docx/model/build.js");

describe("describeDocx cost", () => {
  it("lists the cells of each table row once, not once per cell", () => {
    const wide = (label: string) => row(Array.from({ length: 40 }, (_, i) => cell(p(r(`${label}${i}`)))).join(""));
    const doc = build({ body: tbl(wide("a") + wide("b")) + p(r("end")) });
    describeDocx(doc, { maxChars: 50_000, includeOutline: false });
    vi.mocked(rowCells).mockClear();
    const description = describeDocx(doc, { maxChars: 50_000, includeOutline: false });
    expect(description.text).toContain("(table row 2, cell 40) b39");
    expect(vi.mocked(rowCells).mock.calls.length).toBeLessThanOrEqual(2);
  });
});
