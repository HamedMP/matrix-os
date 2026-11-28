import { describe, expect, it } from "vitest";
import { createXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { openSheetSession } from "../../../../home/apps/sheets/src/session";
import { findMatches, nextMatch, planReplaceAll, replaceText } from "../../../../home/apps/sheets/src/ui/find-replace";
import { MAX_IMPORT_AREA, parsePastedTable } from "../../../../home/apps/sheets/src/ui/import-csv";
import { goToNames, resolveGoTo } from "../../../../home/apps/sheets/src/ui/name-box";
import { changeDecimals, presetOf } from "../../../../home/apps/sheets/src/ui/number-format";
import { selectionStats } from "../../../../home/apps/sheets/src/ui/selection-stats";
import { EMPTY_LOOK, LEGACY_TAB_LOOK_KEY, TabLookStore, moveTab, orderedSheets, pruneLook, setTabColor } from "../../../../home/apps/sheets/src/ui/sheet-tabs-model";
import { harness } from "../session/fakes";

async function sessionWith(build: (wb: ReturnType<typeof createXlsx>, sheet: string) => void) {
  const h = harness();
  const wb = createXlsx();
  const sheet = wb.listSheets()[0]!.id;
  build(wb, sheet);
  wb.recalc();
  h.files.put("Book.xlsx", await wb.save());
  const session = await openSheetSession(h.deps, "Book.xlsx");
  session.setAutosave(false);
  return { session, sheet: session.getState().activeSheetId };
}

describe("selection stats", () => {
  it("sums and averages numbers, counts non-empty cells and counts overlaps once", async () => {
    const { session, sheet } = await sessionWith((wb, s) => {
      wb.setRange(s, { row: 0, col: 0 }, [[1, "x"], [2, true], [3, null]]);
      wb.setFormula(s, { row: 3, col: 0 }, "SUM(A1:A3)");
    });
    const all = { start: { row: 0, col: 0 }, end: { row: 3, col: 1 } };
    expect(selectionStats(session, sheet, [all])).toEqual({ count: 6, numericCount: 4, sum: 12, average: 3, truncated: false });
    const overlap = selectionStats(session, sheet, [all, { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }]);
    expect(overlap.sum).toBe(12);
    const huge = { start: { row: 0, col: 0 }, end: { row: 1_048_575, col: 16_383 } };
    expect(selectionStats(session, sheet, [huge]).count).toBe(6);
    expect(selectionStats(session, sheet, [all], 3).truncated).toBe(true);
  });

  it("reports no average when nothing is numeric", async () => {
    const { session, sheet } = await sessionWith((wb, s) => wb.setCell(s, { row: 0, col: 0 }, "a"));
    expect(selectionStats(session, sheet, [{ start: { row: 0, col: 0 }, end: { row: 4, col: 4 } }]).average).toBeNull();
  });
});

describe("number formats", () => {
  it("recognises presets", () => {
    expect(presetOf("General")).toBe("general");
    expect(presetOf("#,##0.00")).toBe("number");
    expect(presetOf("$#,##0.00")).toBe("currency");
    expect(presetOf("0.0%")).toBe("percent");
    expect(presetOf("yyyy-mm-dd")).toBe("date");
    expect(presetOf("0.000E+00")).toBeNull();
  });

  it("adds and removes decimals in every section and leaves dates alone", () => {
    expect(changeDecimals("General", 1)).toBe("0.0");
    expect(changeDecimals("General", -1)).toBe("0");
    expect(changeDecimals("#,##0.00", 1)).toBe("#,##0.000");
    expect(changeDecimals("#,##0.0", -1)).toBe("#,##0");
    expect(changeDecimals("#,##0", -1)).toBe("#,##0");
    expect(changeDecimals("0%", 1)).toBe("0.0%");
    expect(changeDecimals('$#,##0.00;[Red]-$#,##0.00;"zero"', 1)).toBe('$#,##0.000;[Red]-$#,##0.000;"zero"');
    expect(changeDecimals("yyyy-mm-dd", 1)).toBe("yyyy-mm-dd");
  });
});

describe("name box", () => {
  it("goes to addresses, other sheets and defined names, local names first", async () => {
    const wb = createXlsx({ sheetNames: ["Data", "Other"] });
    const [data, other] = wb.listSheets().map((s) => s.id) as [string, string];
    wb.setDefinedName({ name: "Totals", refersTo: "Other!$B$2:$C$4", scope: null });
    wb.setDefinedName({ name: "Totals", refersTo: "Data!$A$1", scope: data });
    wb.setDefinedName({ name: "Rate", refersTo: "0.2", scope: null });
    expect(resolveGoTo(wb, data, "c7")).toEqual({ ok: true, sheet: data, range: { start: { row: 6, col: 2 }, end: { row: 6, col: 2 } } });
    expect(resolveGoTo(wb, data, "Other!A1:B2")).toMatchObject({ ok: true, sheet: other });
    expect(resolveGoTo(wb, data, "totals")).toEqual({ ok: true, sheet: data, range: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } } });
    expect(resolveGoTo(wb, other, "Totals")).toEqual({ ok: true, sheet: other, range: { start: { row: 1, col: 1 }, end: { row: 3, col: 2 } } });
    expect(resolveGoTo(wb, data, "Rate")).toMatchObject({ ok: false });
    expect(resolveGoTo(wb, data, "Nowhere!A1")).toEqual({ ok: false, message: "There is no sheet with that name." });
    expect(resolveGoTo(wb, data, "unknown_name")).toMatchObject({ ok: false });
    expect(goToNames(wb, other).map((n) => n.name)).toEqual(["Totals"]);
  });
});

describe("find and replace", () => {
  it("finds in values or formulas, by case and whole cell, and replaces typed content only", async () => {
    const { session, sheet } = await sessionWith((wb, s) => {
      wb.setRange(s, { row: 0, col: 0 }, [["Apple pie", "apple"], [1200, null]]);
      wb.setFormula(s, { row: 2, col: 0 }, 'CONCAT("apple", "s")');
    });
    const base = { query: "apple", matchCase: false, wholeCell: false, lookIn: "values" as const };
    expect(findMatches(session, sheet, base).matches).toEqual([{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 2, col: 0 }]);
    expect(findMatches(session, sheet, { ...base, matchCase: true }).matches).toEqual([{ row: 0, col: 1 }, { row: 2, col: 0 }]);
    expect(findMatches(session, sheet, { ...base, wholeCell: true }).matches).toEqual([{ row: 0, col: 1 }]);
    expect(findMatches(session, sheet, { ...base, query: "CONCAT", lookIn: "formulas" }).matches).toEqual([{ row: 2, col: 0 }]);

    const plan = planReplaceAll(session, sheet, base, "pear");
    expect(plan.skipped).toBe(1);
    expect(session.applyEdits(plan.edits, "Replace all")).toEqual({ ok: true });
    expect(session.cell(sheet, 0, 0).value).toBe("pear pie");
    expect(session.cell(sheet, 0, 1).value).toBe("pear");
    expect(session.cell(sheet, 2, 0).value).toBe("apples");

    const formulas = planReplaceAll(session, sheet, { ...base, lookIn: "formulas" }, "plum");
    session.applyEdits(formulas.edits);
    expect(session.cell(sheet, 2, 0).value).toBe("plums");
    const numbers = planReplaceAll(session, sheet, { ...base, query: "12" }, "34");
    session.applyEdits(numbers.edits);
    expect(session.cell(sheet, 1, 0).value).toBe(3400);
  });

  it("keeps the replacement literal and walks matches in reading order", () => {
    expect(replaceText("a.b.a", { query: ".", matchCase: true, wholeCell: false, lookIn: "values" }, "$&")).toBe("a$&b$&a");
    const matches = [{ row: 0, col: 1 }, { row: 2, col: 0 }, { row: 2, col: 3 }];
    expect(nextMatch(matches, { row: 2, col: 0 })).toBe(2);
    expect(nextMatch(matches, { row: 2, col: 3 })).toBe(0);
    expect(nextMatch(matches, { row: 2, col: 0 }, true)).toBe(0);
    expect(nextMatch(matches, { row: 0, col: 0 }, true)).toBe(2);
  });

  // Outcome: Find and Replace only touch text the owner can see.
  // Fault: a file that keeps a value under a merged cell has it found and replaced out of sight.
  it("skips text hidden under a merged cell", async () => {
    const { session, sheet } = await sessionWith((wb, s) => {
      wb.mergeCells(s, { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } });
      // Written after the merge, as another program can leave it in a file.
      wb.setRange(s, { row: 0, col: 0 }, [["apple", "apple"]]);
    });
    const base = { query: "apple", matchCase: false, wholeCell: false, lookIn: "values" as const };
    expect(findMatches(session, sheet, base).matches).toEqual([{ row: 0, col: 0 }]);
    expect(planReplaceAll(session, sheet, base, "pear").edits.map((edit) => [edit.row, edit.col])).toEqual([[0, 0]]);
  });
});

describe("sheet tabs model", () => {
  const sheets = ["a", "b", "c"].map((id, index) => ({ id, name: id.toUpperCase(), index, state: "visible" })) as never[];

  it("orders, moves, colours and prunes", () => {
    let look = moveTab(EMPTY_LOOK, sheets, "c", 0);
    expect(orderedSheets(sheets, look).map((s: { id: string }) => s.id)).toEqual(["c", "a", "b"]);
    look = setTabColor(look, "a", "green");
    expect(look.colors).toEqual({ a: "green" });
    expect(setTabColor(look, "a", null).colors).toEqual({});
    expect(pruneLook(look, sheets.slice(1))).toEqual({ order: ["c", "b"], colors: {} });
  });

  it("persists per file, reads the earlier list, and survives bad stored data", async () => {
    const legacy = { files: [{ path: "x.xlsx", order: [1, "b"], colors: { b: "nope", a: "red" } }] };
    const data: Record<string, unknown> = { [LEGACY_TAB_LOOK_KEY]: legacy };
    const store = new TabLookStore({ readData: async (k) => data[k] ?? null, writeData: async (k, v) => void (data[k] = v) });
    expect(await store.load("x.xlsx")).toEqual({ order: ["b"], colors: { a: "red" } });
    for (let i = 0; i < 3; i++) await store.save(`f${i}.xlsx`, { order: ["a"], colors: {} });
    expect(await store.load("f2.xlsx")).toEqual({ order: ["a"], colors: {} });
    // Saving never rewrites the earlier list, and each key holds one file's tabs.
    expect(data[LEGACY_TAB_LOOK_KEY]).toBe(legacy);
    expect(Object.keys(data).filter((key) => /^sheet_tabs_v2_[0-9a-f]{16}$/.test(key))).toHaveLength(3);
    // Clearing a file's tabs is stored too, so the earlier list does not bring them back.
    await store.save("x.xlsx", EMPTY_LOOK);
    expect(await store.load("x.xlsx")).toEqual(EMPTY_LOOK);
    // At most 256 sheets per file are kept.
    await store.save("big.xlsx", { order: Array.from({ length: 300 }, (_, i) => `s${i}`), colors: {} });
    expect((await store.load("big.xlsx")).order).toHaveLength(256);
    const broken = new TabLookStore({ readData: async () => Promise.reject(new Error("down")) });
    expect(await broken.load("x.xlsx")).toEqual(EMPTY_LOOK);
  });
});

describe("importing pasted rows", () => {
  it("reads fields as text and keeps a leading = from becoming a formula", () => {
    expect(parsePastedTable("name,amount\nTea,=1+1\n")).toEqual({ ok: true, rows: [["name", "amount"], ["Tea", "'=1+1"]] });
  });

  // Outcome: a pasted field longer than a cell holds is refused, not imported cut short.
  // Fault: the CSV reader cut such a field to 32,767 characters and the import reported success.
  it("refuses a field longer than a cell holds instead of cutting it", () => {
    const long = "x".repeat(32_768);
    expect(parsePastedTable(`a,${long}\n`)).toEqual({ ok: false, message: "A pasted field is longer than a cell holds (32,767 characters)." });
    expect(parsePastedTable(`a,${"x".repeat(32_767)}\n`)).toMatchObject({ ok: true });
  });

  it("keeps rows, empty fields between filled ones, and the delimiter the text uses", () => {
    expect(parsePastedTable("\ufeffa;b\n\n;c;\n\n")).toEqual({ ok: true, rows: [["a", "b"], [], ["", "c"]] });
    expect(parsePastedTable("\n\n")).toEqual({ ok: false, message: "Paste some rows first." });
    expect(parsePastedTable(",,\n,\n")).toEqual({ ok: false, message: "No rows were found in the pasted text." });
  });

  it("refuses a paste whose rows span more positions than it reads, without reading them", () => {
    // One wide row over many short ones: few cells, but a table of rows x widest row.
    const text = `${"a,".repeat(9_999)}a\n${"x\n".repeat(Math.ceil(MAX_IMPORT_AREA / 10_000))}`;
    expect(parsePastedTable(text)).toEqual({ ok: false, message: "The pasted text has more cells than Sheets imports at once." });
  });
});
