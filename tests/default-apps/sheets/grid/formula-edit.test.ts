import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "../../../../home/apps/_shared/office-engine/index";
import { cellLook, errorHelp, generalAlign, overflowWidth, textWidth } from "../../../../home/apps/sheets/src/grid/cell-look";
import { DecorationStore, describeDecoration } from "../../../../home/apps/sheets/src/grid/decorations";
import {
  applyCompletion,
  callAt,
  canInsertReference,
  completionAt,
  cycleAbsolute,
  formatReference,
  insertReference,
  matchFunctions,
  scanReferences,
} from "../../../../home/apps/sheets/src/grid/formula-edit";
import { activeHintArg, createFunctionCatalog } from "../../../../home/apps/sheets/src/grid/function-hints";

const range = (r1: number, c1: number, r2: number, c2: number) => ({ start: { row: r1, col: c1 }, end: { row: r2, col: c2 } });

describe("reference highlighting", () => {
  it("finds cells and ranges with their place in the text", () => {
    const refs = scanReferences("=A1+SUM(B2:C5)*$D$7");
    expect(refs.map((ref) => [ref.text, ref.start, ref.end])).toEqual([
      ["A1", 1, 3],
      ["B2:C5", 8, 13],
      ["$D$7", 15, 19],
    ]);
    expect(refs[1]!.range).toEqual(range(1, 1, 4, 2));
    expect(refs.map((ref) => ref.color)).toEqual([0, 1, 2]);
  });

  it("gives the same reference the same colour and normalises corners", () => {
    const refs = scanReferences("=A1+B2+a1+C5:B2");
    expect(refs.map((ref) => ref.color)).toEqual([0, 1, 0, 2]);
    expect(refs[3]!.range).toEqual(range(1, 1, 4, 2));
  });

  it("reads sheet names, whole columns and whole rows", () => {
    const refs = scanReferences("=Sheet2!A1+'My sheet''s'!B2:B3+A:C+2:5");
    expect(refs.map((ref) => ref.sheet)).toEqual(["Sheet2", "My sheet's", null, null]);
    expect(refs[0]!.text).toBe("Sheet2!A1");
    expect(refs[2]!.range).toEqual(range(0, 0, MAX_ROWS - 1, 2));
    expect(refs[3]!.range).toEqual(range(1, 0, 4, MAX_COLS - 1));
  });

  it("ignores strings, function names, names and text that is not a formula", () => {
    expect(scanReferences('="A1"&B1').map((ref) => ref.text)).toEqual(["B1"]);
    expect(scanReferences("=LOG10(A1)+TAXES2024+ABC1X").map((ref) => ref.text)).toEqual(["A1"]);
    expect(scanReferences("=XFE1+A1048577+A0")).toEqual([]);
    expect(scanReferences("A1+B1")).toEqual([]);
    expect(scanReferences("=SUM(A1:").map((ref) => ref.text)).toEqual(["A1"]);
  });

  it("writes references for picked ranges", () => {
    expect(formatReference(range(1, 1, 1, 1))).toBe("B2");
    expect(formatReference(range(1, 1, 4, 2))).toBe("B2:C5");
    expect(formatReference(range(0, 0, MAX_ROWS - 1, 2))).toBe("A:C");
    expect(formatReference(range(1, 0, 4, MAX_COLS - 1))).toBe("2:5");
    expect(formatReference(range(0, 0, 0, 0), "Data")).toBe("Data!A1");
    expect(formatReference(range(0, 0, 0, 0), "My sheet's")).toBe("'My sheet''s'!A1");
  });

  it("knows where a picked reference may go", () => {
    expect(canInsertReference("=", 1)).toBe(true);
    expect(canInsertReference("=A1+", 4)).toBe(true);
    expect(canInsertReference("=SUM(", 5)).toBe(true);
    expect(canInsertReference("=SUM(A1, ", 9)).toBe(true);
    expect(canInsertReference("=A1", 3)).toBe(false);
    expect(canInsertReference('="a+', 4)).toBe(false);
    expect(canInsertReference("hello+", 6)).toBe(false);
    expect(insertReference("=SUM()", 5, 5, "B2:C3")).toEqual({ text: "=SUM(B2:C3)", caret: 10 });
    expect(insertReference("=A1+B2", 4, 6, "C3")).toEqual({ text: "=A1+C3", caret: 6 });
  });

  it("cycles a reference through absolute forms", () => {
    let edit = cycleAbsolute("=A1+B2", 2);
    expect(edit).toEqual({ text: "=$A$1+B2", caret: 5 });
    edit = cycleAbsolute(edit!.text, edit!.caret);
    expect(edit?.text).toBe("=A$1+B2");
    edit = cycleAbsolute(edit!.text, edit!.caret);
    expect(edit?.text).toBe("=$A1+B2");
    edit = cycleAbsolute(edit!.text, edit!.caret);
    expect(edit?.text).toBe("=A1+B2");
    expect(cycleAbsolute("=SUM(A1:B2)", 8)?.text).toBe("=SUM($A$1:$B$2)");
    expect(cycleAbsolute("=Data!A1", 8)?.text).toBe("=Data!$A$1");
    expect(cycleAbsolute("=1+2", 2)).toBeNull();
  });
});

describe("function completion and hints", () => {
  const catalog = createFunctionCatalog();

  it("offers the engine's functions for the letters typed", () => {
    expect(catalog.names.length).toBeGreaterThan(150);
    const completion = completionAt("=su", 3);
    expect(completion).toEqual({ start: 1, end: 3, prefix: "SU" });
    const matches = matchFunctions("SU", catalog.names);
    expect(matches[0]).toBe("SUM");
    expect(matches).toContain("SUMIF");
    expect(matches.every((name) => name.startsWith("SU"))).toBe(true);
    expect(matchFunctions("", catalog.names)).toEqual([]);
    expect(matchFunctions("ZZZZ", catalog.names)).toEqual([]);
  });

  it("does not offer functions for cell references, strings or plain text", () => {
    expect(completionAt("=A1", 3)).toBeNull();
    expect(completionAt('="su', 4)).toBeNull();
    expect(completionAt("su", 2)).toBeNull();
    expect(completionAt("=1+", 3)).toBeNull();
    expect(completionAt("=SUM(A1)+av", 11)).toEqual({ start: 9, end: 11, prefix: "AV" });
    expect(completionAt("=SU(", 3)).toBeNull();
  });

  it("completes the name with an opening bracket", () => {
    expect(applyCompletion("=su", { start: 1, end: 3, prefix: "SU" }, "SUM")).toEqual({ text: "=SUM(", caret: 5 });
    expect(applyCompletion("=1+ave+2", { start: 3, end: 6, prefix: "AVE" }, "AVERAGE")).toEqual({ text: "=1+AVERAGE(+2", caret: 11 });
  });

  it("knows the function and argument at the caret", () => {
    expect(callAt("=SUM(", 5)).toEqual({ name: "SUM", argument: 0 });
    expect(callAt("=IF(A1>2, \"a,b\", ", 17)).toEqual({ name: "IF", argument: 2 });
    expect(callAt("=IF(SUM(A1,B1", 13)).toEqual({ name: "SUM", argument: 1 });
    expect(callAt("=IF(SUM(A1,B1),", 15)).toEqual({ name: "IF", argument: 1 });
    expect(callAt("=SUM((A1+B1)*2,", 15)).toEqual({ name: "SUM", argument: 1 });
    expect(callAt("=SUM({1,2;3,4},", 15)).toEqual({ name: "SUM", argument: 1 });
    expect(callAt("=SUM(A1)", 8)).toBeNull();
    expect(callAt("=1+2", 4)).toBeNull();
  });

  it("names the arguments of common functions and falls back to the registry", () => {
    expect(catalog.hint("if")).toEqual({
      name: "IF",
      args: ["condition", "value_if_true", "[value_if_false]"],
      summary: "One value when the condition holds, another when not.",
    });
    expect(catalog.hint("PI")?.args).toEqual([]);
    expect(catalog.hint("NOPE")).toBeNull();
    for (const name of catalog.names) {
      const hint = catalog.hint(name);
      expect(hint?.name).toBe(name);
      expect(Array.isArray(hint?.args)).toBe(true);
    }
    const sum = catalog.hint("SUM")!;
    expect(activeHintArg(sum, 0)).toBe(0);
    expect(activeHintArg(sum, 1)).toBe(1);
    expect(activeHintArg(sum, 9)).toBe(1);
    const ifHint = catalog.hint("IF")!;
    expect(activeHintArg(ifHint, 2)).toBe(2);
    expect(activeHintArg(ifHint, 3)).toBe(-1);
  });
});

const BASE_STYLE = {
  font: { name: "Calibri", sizePt: 11, bold: false, italic: false, underline: false, strike: false, color: null },
  fill: { color: null },
  border: {
    top: { style: "none", color: null },
    right: { style: "none", color: null },
    bottom: { style: "none", color: null },
    left: { style: "none", color: null },
  },
  alignment: { horizontal: "general", vertical: "bottom", wrapText: false, indent: 0 },
  numberFormat: "General",
} as const;

describe("cell look", () => {
  it("aligns by the kind of value unless the style says otherwise", () => {
    expect(generalAlign(1)).toBe("right");
    expect(generalAlign("a")).toBe("left");
    expect(generalAlign(true)).toBe("center");
    expect(generalAlign({ kind: "error", code: "#N/A" })).toBe("center");
    expect(cellLook(BASE_STYLE, 5)).toMatchObject({ align: "right", wrap: false, css: { justifyContent: "flex-end", alignItems: "flex-end" } });
    expect(cellLook({ ...BASE_STYLE, alignment: { ...BASE_STYLE.alignment, horizontal: "center", vertical: "top" } }, 5).css).toMatchObject({
      justifyContent: "center",
      alignItems: "flex-start",
    });
  });

  it("turns fonts, fills and borders into CSS", () => {
    const look = cellLook(
      {
        ...BASE_STYLE,
        font: { name: 'Evil"; x', sizePt: 22, bold: true, italic: true, underline: true, strike: true, color: "#ff0000" },
        fill: { color: "#ffff00" },
        border: { ...BASE_STYLE.border, bottom: { style: "medium", color: "#0000ff" }, left: { style: "dashed", color: null } },
        alignment: { horizontal: "left", vertical: "middle", wrapText: true, indent: 2 },
      },
      "x",
    );
    expect(look.css).toMatchObject({
      fontSize: "26px",
      fontWeight: 700,
      fontStyle: "italic",
      textDecoration: "underline line-through",
      color: "#ff0000",
      backgroundColor: "#ffff00",
      borderBottom: "2px solid #0000ff",
      borderLeft: "1px dashed currentColor",
      whiteSpace: "pre-wrap",
      paddingLeft: "20px",
      alignItems: "center",
    });
    expect(String(look.css.fontFamily)).toContain('"Evil x"');
    expect(look.wrap).toBe(true);
  });

  it("keeps default black text on the theme colour and picks readable text on fills", () => {
    expect(cellLook({ ...BASE_STYLE, font: { ...BASE_STYLE.font, color: "#000000" } }, "x").css.color).toBeUndefined();
    expect(cellLook({ ...BASE_STYLE, fill: { color: "#102030" } }, "x").css.color).toBe("#ffffff");
    expect(cellLook({ ...BASE_STYLE, fill: { color: "#f0f0f0" } }, "x").css.color).toBe("#111111");
  });

  it("lets text run over empty neighbours until it fits or meets a filled cell", () => {
    const widths = [60, 60, null, 60];
    const neighbour = (index: number) => widths[index - 1] ?? null;
    expect(overflowWidth(50, 80, neighbour)).toBe(0);
    expect(overflowWidth(100, 80, neighbour)).toBe(60);
    expect(overflowWidth(190, 80, neighbour)).toBe(120);
    expect(overflowWidth(900, 80, neighbour)).toBe(120);
    expect(overflowWidth(900, 80, () => 10, 3)).toBe(30);
    expect(textWidth("", cellLook(BASE_STYLE, "x"))).toBe(0);
    expect(textWidth("hello world", cellLook(BASE_STYLE, "x"))).toBeGreaterThan(40);
  });

  it("explains error values", () => {
    expect(errorHelp({ kind: "error", code: "#DIV/0!" })).toBe("Division by zero.");
    expect(errorHelp(5)).toBeNull();
    expect(errorHelp(null)).toBeNull();
  });
});

describe("decorations", () => {
  it("keeps layers apart and reports what is on a cell", () => {
    const store = new DecorationStore();
    const before = store.version;
    store.set("review", [{ sheet: "1", row: 0, col: 0, kind: "proposed", oldValue: "1", newValue: "5", changeId: "c1", label: "Agent" }]);
    store.set("trace", [
      { sheet: "1", row: 0, col: 0, kind: "precedent" },
      { sheet: "1", row: 3, col: 3, kind: "dependent" },
    ]);
    expect(store.version).toBe(before + 2);
    expect(store.at("1", 0, 0).map((entry) => entry.kind)).toEqual(["proposed", "precedent"]);
    expect(store.at("2", 0, 0)).toEqual([]);
    expect(store.within("1", 2, 5, 2, 5).map((entry) => entry.kind)).toEqual(["dependent"]);

    store.set("trace", [{ sheet: "1", row: 9, col: 9, kind: "search" }]);
    expect(store.at("1", 3, 3)).toEqual([]);
    store.set("review", []);
    expect(store.at("1", 0, 0)).toEqual([]);
    store.clear();
    expect(store.get("trace")).toEqual([]);
  });

  it("describes a proposed change with its old and new value", () => {
    expect(describeDecoration({ sheet: "1", row: 0, col: 0, kind: "proposed", oldValue: "", newValue: "5", label: "Agent" })).toBe(
      "Proposed change: was empty, now 5 (Agent)",
    );
    expect(describeDecoration({ sheet: "1", row: 0, col: 0, kind: "search-active" })).toBe("Current search result");
  });
});
