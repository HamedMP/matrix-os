import { describe, expect, it } from "vitest";
import type { FormulaArray, FormulaError, FormulaValue } from "../../../../../packages/office/src/api/formula.js";
import {
  ERR,
  asArray,
  broadcast,
  broadcastShape,
  cellCount,
  collectNumbers,
  compareValues,
  dateSerial,
  finiteOrError,
  firstError,
  flattenValues,
  isArray,
  isError,
  makeArray,
  makeError,
  mapValue,
  numberToText,
  parseNumberText,
  toBoolean,
  toNumber,
  toScalar,
  toText,
  valuesEqual,
} from "../../../../../packages/office/src/xlsx/formula/coerce.js";

const err = (code: FormulaError["code"]) => expect.objectContaining({ kind: "error", code });

describe("error values", () => {
  it("builds and recognises errors", () => {
    expect(makeError("#DIV/0!")).toEqual({ kind: "error", code: "#DIV/0!" });
    expect(makeError("#NUM!", "too deep")).toEqual({ kind: "error", code: "#NUM!", message: "too deep" });
    expect(isError(ERR.NA)).toBe(true);
    expect(isError("#N/A")).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isError(makeArray([[1]]))).toBe(false);
  });

  it("finds the first error among values, looking inside arrays", () => {
    expect(firstError([1, "a", null])).toBeNull();
    expect(firstError([1, ERR.VALUE, ERR.NA])).toEqual(err("#VALUE!"));
    expect(firstError([1, makeArray([[1, ERR.REF]])])).toEqual(err("#REF!"));
  });
});

describe("toNumber", () => {
  it.each([
    [5, 5],
    [null, 0],
    [true, 1],
    [false, 0],
    ["12", 12],
    [" 12.5 ", 12.5],
    ["-3", -3],
    ["+3", 3],
    ["1e3", 1000],
    ["1.5E-2", 0.015],
    [".5", 0.5],
    ["5.", 5],
    ["50%", 0.5],
    ["1,234.5", 1234.5],
    ["$1,234", 1234],
    ["-$5", -5],
  ])("converts %j to %j", (input, expected) => {
    expect(toNumber(input)).toBe(expected);
  });

  it.each(["", " ", "abc", "1 2", "1,23", "12abc", "--1", "1e", "%", "0x10", "Infinity", "NaN"])(
    "gives #VALUE! for the text %j",
    (input) => {
      expect(toNumber(input)).toEqual(err("#VALUE!"));
    },
  );

  it("passes an error through", () => {
    expect(toNumber(ERR.DIV0)).toBe(ERR.DIV0);
  });

  it("reads ISO dates and times as serial numbers", () => {
    expect(toNumber("1900-03-01")).toBe(61);
    expect(toNumber("2024-01-15")).toBe(45306);
    expect(toNumber("2024-01-15 12:00")).toBe(45306.5);
    expect(toNumber("2024-01-15T06:00:00")).toBe(45306.25);
    expect(toNumber("18:00")).toBe(0.75);
    expect(toNumber("2024-02-30")).toEqual(err("#VALUE!"));
    expect(toNumber("2024-01-15", { date1904: true })).toBe(45306 - 1462);
  });

  it("takes the top-left value of an array", () => {
    expect(toNumber(makeArray([["7", 2]]))).toBe(7);
  });
});

describe("dateSerial", () => {
  it("follows the 1900 date system including its leap-year quirk", () => {
    expect(dateSerial(1900, 1, 1)).toBe(1);
    expect(dateSerial(1900, 2, 28)).toBe(59);
    expect(dateSerial(1900, 3, 1)).toBe(61);
    expect(dateSerial(2000, 1, 1)).toBe(36526);
  });

  it("follows the 1904 date system", () => {
    expect(dateSerial(1904, 1, 1, true)).toBe(0);
    expect(dateSerial(1904, 1, 2, true)).toBe(1);
  });
});

describe("toText", () => {
  it.each([
    [null, ""],
    ["abc", "abc"],
    [true, "TRUE"],
    [false, "FALSE"],
    [0, "0"],
    [-0, "0"],
    [1.5, "1.5"],
    [0.1 + 0.2, "0.3"],
    [1 / 3, "0.333333333333333"],
    [123456789012, "123456789012"],
    [1e21, "1E+21"],
    [1.5e-7, "1.5E-07"],
    [-2.5e25, "-2.5E+25"],
  ])("converts %j to %j", (input, expected) => {
    expect(toText(input)).toBe(expected);
  });

  it("passes an error through", () => {
    expect(toText(ERR.NAME)).toBe(ERR.NAME);
  });

  it("formats numbers without a locale", () => {
    expect(numberToText(1234567.891)).toBe("1234567.891");
  });
});

describe("toBoolean", () => {
  it.each([
    [true, true],
    [false, false],
    [null, false],
    [0, false],
    [2, true],
    [-0.5, true],
    ["TRUE", true],
    ["true", true],
    ["False", false],
  ])("converts %j to %j", (input, expected) => {
    expect(toBoolean(input)).toBe(expected);
  });

  it("gives #VALUE! for other text and passes errors through", () => {
    expect(toBoolean("yes")).toEqual(err("#VALUE!"));
    expect(toBoolean("")).toEqual(err("#VALUE!"));
    expect(toBoolean(ERR.NA)).toBe(ERR.NA);
  });
});

describe("parseNumberText", () => {
  it("returns null for text that is not a number", () => {
    expect(parseNumberText("abc")).toBeNull();
    expect(parseNumberText("12")).toBe(12);
  });
});

describe("compareValues", () => {
  it("orders numbers before text before booleans", () => {
    expect(compareValues(1e9, "a")).toBeLessThan(0);
    expect(compareValues("zzz", false)).toBeLessThan(0);
    expect(compareValues(true, 1e9)).toBeGreaterThan(0);
    expect(compareValues(false, true)).toBeLessThan(0);
  });

  it("does not convert between numbers and text", () => {
    expect(compareValues(1, "1")).not.toBe(0);
    expect(valuesEqual(1, "1")).toBe(false);
  });

  it("compares text without regard to case", () => {
    expect(compareValues("Apple", "apple")).toBe(0);
    expect(compareValues("apple", "Banana")).toBeLessThan(0);
    expect(compareValues("b", "A")).toBeGreaterThan(0);
  });

  it("treats a blank as the empty value of the other side", () => {
    expect(compareValues(null, 0)).toBe(0);
    expect(compareValues(null, "")).toBe(0);
    expect(compareValues(null, false)).toBe(0);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(null, 1)).toBeLessThan(0);
    expect(compareValues("a", null)).toBeGreaterThan(0);
  });

  it("ignores binary rounding noise in the fifteenth digit", () => {
    expect(compareValues(0.1 + 0.2, 0.3)).toBe(0);
    expect(compareValues(1, 1.0000001)).toBeLessThan(0);
  });
});

describe("arrays", () => {
  const range: FormulaArray = {
    kind: "array",
    rows: 2,
    cols: 2,
    values: [
      [1, "x"],
      [null, true],
    ],
    ref: { sheet: "S", startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
  };

  it("wraps and unwraps scalars", () => {
    expect(asArray(5)).toEqual({ kind: "array", rows: 1, cols: 1, values: [[5]], ref: null });
    expect(asArray(range)).toBe(range);
    expect(toScalar(range)).toBe(1);
    expect(toScalar("a")).toBe("a");
    expect(toScalar(makeArray([]))).toBeNull();
    expect(isArray(range)).toBe(true);
    expect(isArray(ERR.NA)).toBe(false);
  });

  it("flattens row by row", () => {
    expect(flattenValues(range)).toEqual([1, "x", null, true]);
    expect(flattenValues(3)).toEqual([3]);
  });

  it("rejects ragged rows", () => {
    expect(() => makeArray([[1, 2], [3]])).toThrowError(/same length/);
  });
});

describe("collectNumbers", () => {
  const cells = makeArray([[1, "2", true, null, "x", 4]]);

  it("counts only numbers inside ranges and arrays", () => {
    expect(collectNumbers([cells])).toEqual([1, 4]);
  });

  it("converts values typed directly as arguments", () => {
    expect(collectNumbers([1, "2", true, null])).toEqual([1, 2, 1, 0]);
    expect(collectNumbers([1, "x"])).toEqual(err("#VALUE!"));
  });

  it("returns the first error it meets", () => {
    expect(collectNumbers([1, makeArray([[2, ERR.DIV0]]), ERR.NA])).toEqual(err("#DIV/0!"));
  });

  it("can count text and booleans in ranges, skip direct text, and skip errors", () => {
    expect(collectNumbers([cells], { inRange: "zero" })).toEqual([1, 0, 1, 0, 4]);
    expect(collectNumbers([1, "x", true], { direct: "skip" })).toEqual([1]);
    expect(collectNumbers([1, ERR.NA, makeArray([[ERR.REF, 2]])], { errors: "skip" })).toEqual([1, 2]);
  });
});

describe("broadcast", () => {
  const add = (values: readonly FormulaValue[]) =>
    broadcast(values, ([a, b]) => (typeof a === "number" && typeof b === "number" ? a + b : ERR.VALUE));

  it("gives a scalar for scalars and single cells", () => {
    expect(add([1, 2])).toBe(3);
    expect(add([makeArray([[5]]), 2])).toBe(7);
    expect(broadcastShape([1, makeArray([[5]])])).toBeNull();
  });

  it("applies a function element by element", () => {
    const result = add([makeArray([[1, 2], [3, 4]]), 10]);
    expect(result).toEqual({ kind: "array", rows: 2, cols: 2, values: [[11, 12], [13, 14]], ref: null });
  });

  it("repeats a single row down and a single column across", () => {
    const result = add([makeArray([[1, 2, 3]]), makeArray([[10], [20]])]) as FormulaArray;
    expect(result.values).toEqual([
      [11, 12, 13],
      [21, 22, 23],
    ]);
  });

  it("reads #N/A outside a smaller array", () => {
    const pick = broadcast([makeArray([[1, 2], [3, 4]]), makeArray([[1, 2, 3], [4, 5, 6], [7, 8, 9]])], ([a]) => a ?? null);
    expect((pick as FormulaArray).values[0]).toEqual([1, 2, err("#N/A")]);
    expect((pick as FormulaArray).values[2]).toEqual([err("#N/A"), err("#N/A"), err("#N/A")]);
  });

  it("reads an empty array as one blank", () => {
    expect(broadcast([makeArray([]), 1], ([a, b]) => (a === null ? b ?? null : ERR.VALUE))).toBe(1);
  });

  it("refuses a result above the bound", () => {
    expect(add([makeArray([[1, 2, 3]]), makeArray([[1], [2], [3]])])).toMatchObject({ rows: 3, cols: 3 });
    expect(broadcast([makeArray([[1, 2, 3]]), makeArray([[1], [2], [3]])], () => 0, 8)).toEqual(err("#NUM!"));
  });

  it("maps one value and counts cells", () => {
    expect(mapValue(2, (v) => (v as number) * 2)).toBe(4);
    expect((mapValue(makeArray([[1, 2]]), (v) => (v as number) * 2) as FormulaArray).values).toEqual([[2, 4]]);
    expect(cellCount(makeArray([[1, 2], [3, 4]]))).toBe(4);
    expect(cellCount("a")).toBe(1);
    expect(finiteOrError(1 / 0)).toEqual(err("#NUM!"));
    expect(finiteOrError(2)).toBe(2);
  });
});
