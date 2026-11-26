// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_PASTE_CHARS, MAX_PASTE_COLS, MAX_PASTE_ROWS, clipMarkOf, newClipMark, parseHtmlTable, parseTsv, readClipboard, serializeHtmlTable, serializeTsv } from "../../../../home/apps/sheets/src/grid/clipboard";
import { type FillSource, adjustFormula, createFiller, fillFromEdge, fillTarget, planFill } from "../../../../home/apps/sheets/src/grid/fill";
import { compareValues, distinctValues, filterHiddenRows, planSort, sortOrder } from "../../../../home/apps/sheets/src/grid/sort-filter";

describe("tab-separated clipboard text", () => {
  it("writes rows and quotes what would break them", () => {
    expect(serializeTsv([["a", "b"], ["1", "2"]])).toBe("a\tb\n1\t2");
    expect(serializeTsv([["say \"hi\"", "two\nlines", "tab\there"]])).toBe('"say ""hi"""\t"two\nlines"\t"tab\there"');
  });

  it("reads what spreadsheets write, with any line ending", () => {
    expect(parseTsv("a\tb\r\n1\t2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseTsv("a\tb\n\n1\t\n")).toEqual([["a", "b"], [""], ["1", ""]]);
    expect(parseTsv('"two\nlines"\t"say ""hi"""\tplain')).toEqual([["two\nlines", 'say "hi"', "plain"]]);
    expect(parseTsv('5" pipe\tb')).toEqual([['5" pipe', "b"]]);
    expect(parseTsv('"unclosed\tb')).toEqual([['"unclosed', "b"]]);
    expect(parseTsv("")).toEqual([]);
    expect(parseTsv("single")).toEqual([["single"]]);
  });

  it("round-trips every value", () => {
    const rows = [["plain", "", "tab\tin", 'quote"in'], ["line\nbreak", "=A1+1", "  spaces  ", "ünï"]];
    expect(parseTsv(serializeTsv(rows))).toEqual(rows);
  });
});

describe("HTML table clipboard", () => {
  it("writes a table other programs can paste, with formulas for Sheets", () => {
    const html = serializeHtmlTable(
      [
        [{ text: "Total", bold: true }, { text: "12", formula: "SUM(A1:A3)", align: "right" }],
        [{ text: "<b>&\"x\"", color: "#ff0000", background: "#00ff00" }, { text: "a\nb" }],
      ],
      { row: 4, col: 1 },
    );
    expect(html).toContain('<table data-sheets-origin="4,1">');
    expect(html).toContain('<td style="font-weight:bold">Total</td>');
    expect(html).toContain('<td style="text-align:right" data-sheets-formula="SUM(A1:A3)">12</td>');
    expect(html).toContain("&lt;b&gt;&amp;&quot;x&quot;");
    expect(html).toContain("a<br>b");
    expect(html).not.toContain("<b>");
  });

  it("reads its own tables back with formulas and origin", () => {
    const html = serializeHtmlTable([[{ text: "Total" }, { text: "12", formula: 'IF(A1>"a<b",1,2)' }], [{ text: "a\nb" }, { text: "" }]], { row: 4, col: 1 });
    expect(parseHtmlTable(html)).toEqual({
      rows: [["Total", '=IF(A1>"a<b",1,2)'], ["a\nb", ""]],
      formulas: [[null, 'IF(A1>"a<b",1,2)'], [null, null]],
      origin: { row: 4, col: 1 },
    });
  });

  it("reads tables from other programs: spans, nested markup, entities", () => {
    const html = `<html><body><style>td{color:red}</style><table>
      <tr><th colspan="2">Head&nbsp;er</th><th>C</th></tr>
      <tr><td rowspan="2"><b>big</b> <i>cell</i></td><td>1</td><td>a<br>b</td></tr>
      <tr><td>2</td><td><script>alert(1)</script>x &amp; y</td></tr>
    </table></body></html>`;
    const table = parseHtmlTable(html);
    expect(table?.rows).toEqual([
      ["Head er", "", "C"],
      ["big cell", "1", "a\nb"],
      ["", "2", "x & y"],
    ]);
    expect(table?.origin).toBeNull();
    expect(parseHtmlTable("<p>no table here</p>")).toBeNull();
  });

  // Outcome: a pasted table whose spans cover more cells than one paste writes is refused as too large.
  // Fault: a few bytes of HTML (one wide colspan, many empty rows) expand into millions of cells and
  // freeze the app before the size check runs.
  it("refuses a table whose spans cover too many cells, before expanding them", () => {
    const wide = `<table><tr><td colspan="2000">x</td></tr>${"<tr></tr>".repeat(999)}</table>`;
    expect(parseHtmlTable(wide)).toEqual({ rows: [], formulas: [], origin: null, tooLarge: true });
    const tall = `<table><tr><td rowspan="100000">x</td>${"<td></td>".repeat(1999)}</tr>${"<tr></tr>".repeat(999)}</table>`;
    expect(parseHtmlTable(tall)?.tooLarge).toBe(true);
    expect(readClipboard({ html: wide, text: "x" })?.tooLarge).toBe(true);
    expect(readClipboard({ text: `${"\t".repeat(1999)}x\n${"\n".repeat(999)}` })?.tooLarge).toBe(true);
    expect(parseHtmlTable(`<table><tr><td colspan="3">x</td></tr><tr><td>1</td></tr></table>`)?.rows).toEqual([["x", "", ""], ["1", "", ""]]);
  });

  // Outcome: a paste beyond the row, column or length limits is refused whole, never pasted in part.
  // Fault: the parsers dropped fields past the column limit, rows past the row limit and text past the
  // length limit, and the rest pasted as if it were the whole table.
  it("refuses a table beyond the row, column or length limits instead of pasting part of it", () => {
    const wideRow = Array.from({ length: MAX_PASTE_COLS + 1 }, (_, i) => String(i)).join("\t");
    expect(parseTsv(wideRow)).toBeNull();
    expect(readClipboard({ text: wideRow })?.tooLarge).toBe(true);
    expect(parseTsv(Array.from({ length: MAX_PASTE_COLS }, () => "x").join("\t"))?.[0]).toHaveLength(MAX_PASTE_COLS);

    const tall = "1\n".repeat(MAX_PASTE_ROWS + 1);
    expect(parseTsv(tall)).toBeNull();
    expect(readClipboard({ text: tall })?.tooLarge).toBe(true);
    expect(parseTsv("1\n".repeat(MAX_PASTE_ROWS))).toHaveLength(MAX_PASTE_ROWS);

    const long = `a\t${"b".repeat(MAX_PASTE_CHARS)}`;
    expect(parseTsv(long)).toBeNull();
    expect(readClipboard({ text: long })?.tooLarge).toBe(true);

    const wideHtml = `<table><tr>${"<td>x</td>".repeat(MAX_PASTE_COLS + 1)}</tr></table>`;
    expect(parseHtmlTable(wideHtml)?.tooLarge).toBe(true);
    const wideSpan = `<table><tr><td>a</td><td colspan="${MAX_PASTE_COLS}">x</td></tr></table>`;
    expect(parseHtmlTable(wideSpan)?.tooLarge).toBe(true);
    const tallHtml = `<table>${"<tr><td>1</td></tr>".repeat(MAX_PASTE_ROWS + 1)}</table>`;
    expect(parseHtmlTable(tallHtml)?.tooLarge).toBe(true);
    expect(readClipboard({ html: wideHtml, text: "x" })?.tooLarge).toBe(true);
    // HTML too long to parse: its table is refused, not pasted from the text without its formulas.
    const padding = " ".repeat(MAX_PASTE_CHARS);
    expect(readClipboard({ html: `<table><tr><td data-sheets-formula="A1">1</td></tr></table>${padding}`, text: "1" })?.tooLarge).toBe(true);
    expect(readClipboard({ html: `<p>x</p>${padding}`, text: "a\tb" })?.rows).toEqual([["a", "b"]]);
  });

  it("marks each copy's table with its own mark, read back without parsing the HTML", () => {
    const mark = newClipMark();
    expect(mark).toMatch(/^[0-9a-f]{32}$/);
    expect(newClipMark()).not.toBe(mark);
    const html = serializeHtmlTable([[{ text: "1" }]], { row: 0, col: 0 }, undefined, mark);
    expect(clipMarkOf(html)).toBe(mark);
    // Still found in HTML too long to parse, and only on the first table.
    expect(clipMarkOf(`${html}${" ".repeat(MAX_PASTE_CHARS)}`)).toBe(mark);
    expect(clipMarkOf(`<table><tr><td>x</td></tr></table>${html}`)).toBeNull();
    expect(clipMarkOf(serializeHtmlTable([[{ text: "1" }]], undefined, undefined, "not a mark"))).toBeNull();
    expect(clipMarkOf("<p>no table</p>")).toBeNull();
  });

  it("prefers the table and falls back to text", () => {
    const html = serializeHtmlTable([[{ text: "3", formula: "A1+2" }]]);
    expect(readClipboard({ html, text: "3" })?.rows).toEqual([["=A1+2"]]);
    expect(readClipboard({ html: "<p>x</p>", text: "a\tb" })).toEqual({ rows: [["a", "b"]], formulas: [[null, null]], origin: null });
    expect(readClipboard({ html: "", text: "" })).toBeNull();
  });
});

const num = (value: number): FillSource => ({ value, formula: null });
const text = (value: string): FillSource => ({ value, formula: null });
const values = (source: FillSource[], from: number, count: number) => {
  const filler = createFiller(source);
  return Array.from({ length: count }, (_, i) => {
    const result = filler(from + i);
    return "formula" in result ? `=${result.formula}` : result.value;
  });
};

describe("fill series", () => {
  it("continues a line through numbers and copies a single number", () => {
    expect(values([num(1), num(2)], 2, 3)).toEqual([3, 4, 5]);
    expect(values([num(10), num(20), num(30)], 3, 2)).toEqual([40, 50]);
    expect(values([num(5), num(3)], 2, 3)).toEqual([1, -1, -3]);
    expect(values([num(0.1), num(0.2)], 2, 2)).toEqual([0.3, 0.4]);
    expect(values([num(7)], 1, 3)).toEqual([7, 7, 7]);
    // Backwards (dragging up or left).
    expect(values([num(4), num(6)], -2, 2)).toEqual([0, 2]);
  });

  it("continues dates by a day and several dates by their step", () => {
    expect(values([{ value: 46000, formula: null, isDate: true }], 1, 2)).toEqual([46001, 46002]);
    expect(values([{ value: 46000, formula: null, isDate: true }, { value: 46007, formula: null, isDate: true }], 2, 2)).toEqual([46014, 46021]);
  });

  it("counts on in text that ends with a number", () => {
    expect(values([text("Item 1")], 1, 2)).toEqual(["Item 2", "Item 3"]);
    expect(values([text("Q1"), text("Q3")], 2, 2)).toEqual(["Q5", "Q7"]);
    expect(values([text("Week 08")], 1, 3)).toEqual(["Week 09", "Week 10", "Week 11"]);
    expect(values([text("a1"), text("b1")], 2, 2)).toEqual(["a1", "b1"]);
  });

  it("goes round weekday and month names", () => {
    expect(values([text("Fri")], 1, 3)).toEqual(["Sat", "Sun", "Mon"]);
    expect(values([text("monday"), text("wednesday")], 2, 2)).toEqual(["friday", "sunday"]);
    expect(values([text("NOV")], 1, 2)).toEqual(["DEC", "JAN"]);
    expect(values([text("December")], -1, 1)).toEqual(["November"]);
  });

  it("repeats anything without a pattern", () => {
    expect(values([text("x"), num(1)], 2, 3)).toEqual(["x", 1, "x"]);
    expect(values([{ value: true, formula: null }], 1, 1)).toEqual([true]);
    expect(values([num(1), num(2)], 2, 2).length).toBe(2);
    const copyOnly = createFiller([num(1), num(2)], false);
    expect([copyOnly(2), copyOnly(3)]).toEqual([{ value: 1 }, { value: 2 }]);
  });
});

describe("fill planning", () => {
  it("moves relative references and leaves absolute ones", () => {
    expect(adjustFormula("A1+$B$1+A$1+$A1", 2, 1)).toBe("B3+$B$1+B$1+$A3");
    expect(adjustFormula("SUM(A1:A3)*Sheet2!C1", 1, 0)).toBe("SUM(A2:A4)*Sheet2!C2");
    expect(adjustFormula("A1", -1, 0)).toBe("#REF!");
    expect(adjustFormula("A1+", 1, 0)).toBe("A1+");
    expect(adjustFormula("A1", 0, 0)).toBe("A1");
  });

  it("picks the direction of a fill-handle drag", () => {
    const source = { start: { row: 2, col: 2 }, end: { row: 3, col: 3 } };
    expect(fillTarget(source, { row: 3, col: 3 })).toBeNull();
    expect(fillTarget(source, { row: 6, col: 3 })).toEqual({ direction: "down", target: { start: { row: 4, col: 2 }, end: { row: 6, col: 3 } } });
    expect(fillTarget(source, { row: 0, col: 2 })).toEqual({ direction: "up", target: { start: { row: 0, col: 2 }, end: { row: 1, col: 3 } } });
    expect(fillTarget(source, { row: 3, col: 7 })).toEqual({ direction: "right", target: { start: { row: 2, col: 4 }, end: { row: 3, col: 7 } } });
    expect(fillTarget(source, { row: 4, col: 0 })).toEqual({ direction: "left", target: { start: { row: 2, col: 0 }, end: { row: 3, col: 1 } } });
  });

  it("fills each column with its own pattern and adjusts formulas per cell", () => {
    const grid: Record<string, FillSource> = {
      "0,0": num(1),
      "1,0": num(2),
      "0,1": { value: 2, formula: "A1*2" },
      "1,1": { value: 4, formula: "A2*$C$1" },
    };
    const read = (row: number, col: number) => grid[`${row},${col}`] ?? { value: null, formula: null };
    const edits = planFill({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } }, { start: { row: 2, col: 0 }, end: { row: 4, col: 1 } }, "down", read);
    expect(edits).toEqual([
      { row: 2, col: 0, from: { row: 0, col: 0 }, value: 3 },
      { row: 3, col: 0, from: { row: 1, col: 0 }, value: 4 },
      { row: 4, col: 0, from: { row: 0, col: 0 }, value: 5 },
      { row: 2, col: 1, from: { row: 0, col: 1 }, formula: "A3*2" },
      { row: 3, col: 1, from: { row: 1, col: 1 }, formula: "A4*$C$1" },
      { row: 4, col: 1, from: { row: 0, col: 1 }, formula: "A5*2" },
    ]);
  });

  it("fills sideways and backwards", () => {
    const read = (row: number, col: number) => (col === 3 ? { value: 9, formula: "C1+1" } : { value: null, formula: null });
    expect(planFill({ start: { row: 0, col: 3 }, end: { row: 0, col: 3 } }, { start: { row: 0, col: 4 }, end: { row: 0, col: 5 } }, "right", read)).toEqual([
      { row: 0, col: 4, from: { row: 0, col: 3 }, formula: "D1+1" },
      { row: 0, col: 5, from: { row: 0, col: 3 }, formula: "E1+1" },
    ]);
    expect(planFill({ start: { row: 0, col: 3 }, end: { row: 0, col: 3 } }, { start: { row: 0, col: 2 }, end: { row: 0, col: 2 } }, "left", read)).toEqual([
      { row: 0, col: 2, from: { row: 0, col: 3 }, formula: "B1+1" },
    ]);
  });

  it("finds the source of ctrl-d and ctrl-r", () => {
    const block = { start: { row: 2, col: 1 }, end: { row: 4, col: 2 } };
    expect(fillFromEdge(block, "down")).toEqual({
      source: { start: { row: 2, col: 1 }, end: { row: 2, col: 2 } },
      target: { start: { row: 3, col: 1 }, end: { row: 4, col: 2 } },
    });
    expect(fillFromEdge(block, "right")).toEqual({
      source: { start: { row: 2, col: 1 }, end: { row: 4, col: 1 } },
      target: { start: { row: 2, col: 2 }, end: { row: 4, col: 2 } },
    });
    const one = { start: { row: 2, col: 1 }, end: { row: 2, col: 1 } };
    expect(fillFromEdge(one, "down")).toEqual({ source: { start: { row: 1, col: 1 }, end: { row: 1, col: 1 } }, target: one });
    expect(fillFromEdge({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, "down")).toBeNull();
    expect(fillFromEdge({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, "right")).toBeNull();
  });
});

describe("sort and filter", () => {
  it("orders values as spreadsheets do, with empty cells last both ways", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(10, "2")).toBeLessThan(0);
    expect(compareValues("apple", "Banana")).toBeLessThan(0);
    expect(compareValues("z", true)).toBeLessThan(0);
    expect(compareValues(true, { kind: "error", code: "#N/A" })).toBeLessThan(0);
    const keys = [[3], [null], ["b"], [1], ["A"]];
    expect(sortOrder(keys, [false])).toEqual([3, 0, 4, 2, 1]);
    expect(sortOrder(keys, [true])).toEqual([2, 4, 0, 3, 1]);
    expect(sortOrder([[1, "b"], [1, "a"], [0, "z"]], [false, false])).toEqual([2, 1, 0]);
  });

  it("moves whole rows, keeps the header and adjusts formulas that move", () => {
    const sheet: Record<string, { value: unknown; formula: string | null; styleId: number }> = {
      "0,0": { value: "name", formula: null, styleId: 1 },
      "0,1": { value: "double", formula: null, styleId: 1 },
      "1,0": { value: 30, formula: null, styleId: 0 },
      "1,1": { value: 60, formula: "A2*2", styleId: 0 },
      "2,0": { value: 10, formula: null, styleId: 2 },
      "2,1": { value: 20, formula: "A3*2", styleId: 0 },
      "3,0": { value: 20, formula: null, styleId: 0 },
      "3,1": { value: 40, formula: "A4*2", styleId: 0 },
    };
    const read = (row: number, col: number) => (sheet[`${row},${col}`] ?? { value: null, formula: null, styleId: 0 }) as never;
    const plan = planSort({ start: { row: 0, col: 0 }, end: { row: 3, col: 1 } }, [{ col: 0 }], true, read);
    expect(plan).toEqual([
      { row: 1, col: 0, cell: { value: 10, formula: null, styleId: 2 } },
      { row: 1, col: 1, cell: { value: 20, formula: "A2*2", styleId: 0 } },
      { row: 2, col: 0, cell: { value: 20, formula: null, styleId: 0 } },
      { row: 2, col: 1, cell: { value: 40, formula: "A3*2", styleId: 0 } },
      { row: 3, col: 0, cell: { value: 30, formula: null, styleId: 0 } },
      { row: 3, col: 1, cell: { value: 60, formula: "A4*2", styleId: 0 } },
    ]);
    // Already in order: nothing to write.
    expect(planSort({ start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }, [{ col: 0 }], false, read)).toEqual([]);
  });

  it("hides the rows that fail a filter and never the header", () => {
    const rows = [["Fruit", "Qty"], ["Apple", "3"], ["Pear", "0"], ["Apple", "7"], ["Plum", ""]];
    const display = (row: number, col: number) => rows[row]?.[col] ?? "";
    const range = { start: { row: 0, col: 0 }, end: { row: 4, col: 1 } };
    expect([...filterHiddenRows({ range, criteria: [{ col: 0, values: ["Apple"] }] }, display)]).toEqual([2, 4]);
    expect([...filterHiddenRows({ range, criteria: [{ col: 0, contains: "p" }, { col: 1, values: ["0", ""] }] }, display)]).toEqual([1, 3]);
    expect(filterHiddenRows({ range, criteria: [] }, display).size).toBe(0);
    expect(distinctValues(range, 0, display)).toEqual(["Apple", "Pear", "Plum"]);
  });
});
