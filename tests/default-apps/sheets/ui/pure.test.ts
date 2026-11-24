import { describe, expect, it } from "vitest";
import { createXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { openSheetSession } from "../../../../home/apps/sheets/src/session";
import { findMatches, nextMatch, planReplaceAll, replaceText } from "../../../../home/apps/sheets/src/ui/find-replace";
import { goToNames, resolveGoTo } from "../../../../home/apps/sheets/src/ui/name-box";
import { changeDecimals, presetOf } from "../../../../home/apps/sheets/src/ui/number-format";
import { selectionStats } from "../../../../home/apps/sheets/src/ui/selection-stats";
import { EMPTY_LOOK, TAB_LOOK_KEY, TabLookStore, moveTab, orderedSheets, pruneLook, setTabColor } from "../../../../home/apps/sheets/src/ui/sheet-tabs-model";
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

  it("persists per file with a cap and survives bad stored data", async () => {
    const data: Record<string, unknown> = { [TAB_LOOK_KEY]: { files: [{ path: "x.xlsx", order: [1, "b"], colors: { b: "nope", a: "red" } }] } };
    const store = new TabLookStore({ readData: async (k) => data[k], writeData: async (k, v) => void (data[k] = v) });
    expect(await store.load("x.xlsx")).toEqual({ order: ["b"], colors: { a: "red" } });
    for (let i = 0; i < 60; i++) await store.save(`f${i}.xlsx`, { order: ["a"], colors: {} });
    expect((data[TAB_LOOK_KEY] as { files: unknown[] }).files).toHaveLength(50);
    expect(await store.load("f59.xlsx")).toEqual({ order: ["a"], colors: {} });
    const broken = new TabLookStore({ readData: async () => Promise.reject(new Error("down")) });
    expect(await broken.load("x.xlsx")).toEqual(EMPTY_LOOK);
  });
});
