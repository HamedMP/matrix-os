import { describe, expect, it } from "vitest";
import type { CellValue } from "../../../../packages/office/src/api/xlsx.js";
import {
  builtinFormatCode,
  formatValue,
  formatValueDetailed,
  isDateFormat,
} from "../../../../packages/office/src/xlsx/format/index.js";

const NA: CellValue = { kind: "error", code: "#N/A" };

describe("General", () => {
  it.each<[CellValue, string]>([
    [0, "0"],
    [42, "42"],
    [-17, "-17"],
    [3.14159, "3.14159"],
    [0.1 + 0.2, "0.3"],
    [1234567890123, "1.23457E+12"],
    [12345678901, "12345678901"],
    [123456789012, "1.23457E+11"],
    [1e21, "1E+21"],
    [123456.7890123, "123456.789"],
    [3.14159265358979, "3.141592654"],
    [0.000123, "0.000123"],
    [0.00001, "0.00001"],
    [0.0000123456, "1.23456E-05"],
    [1.5e-12, "1.5E-12"],
    [-0.5, "-0.5"],
    [100, "100"],
    [1e10, "10000000000"],
    ["text", "text"],
    [true, "TRUE"],
    [false, "FALSE"],
    [NA, "#N/A"],
    [null, ""],
  ])("formats %j as %j", (value, expected) => {
    expect(formatValue(value, "General")).toBe(expected);
  });

  it("is case-insensitive and keeps literals around it", () => {
    expect(formatValue(5, "general")).toBe("5");
    expect(formatValue(5, '"about "General')).toBe("about 5");
    expect(formatValue(Number.NaN, "General")).toBe("#NUM!");
  });
});

describe("fixed decimals, thousands, percent and scaling", () => {
  it.each<[number, string, string]>([
    [1234.5, "0", "1235"],
    [0.5, "0", "1"],
    [1.5, "0", "2"],
    [2.5, "0", "3"],
    [-2.5, "0", "-3"],
    [1234.5, "0.00", "1234.50"],
    [1.005, "0.00", "1.01"],
    [0.285, "0.00", "0.29"],
    [-0.001, "0.00", "-0.00"],
    [0, "0.00", "0.00"],
    [1234.5, "#,##0", "1,235"],
    [1234567.891, "#,##0.00", "1,234,567.89"],
    [12, "#,##0", "12"],
    [0, "#,##0", "0"],
    [0, "#,###", ""],
    [999.5, "#,##0", "1,000"],
    [1, "0,000", "0,001"],
    [42, "00000", "00042"],
    [123456, "00000", "123456"],
    [5, "#.##", "5."],
    [5.126, "#.##", "5.13"],
    [0.5, ".00", ".50"],
    [0.5, "#.00", ".50"],
    [1.5, "0.0?", "1.5 "],
    [1.25, "0.0#", "1.25"],
    [1.2, "0.0#", "1.2"],
    [12, "??0", " 12"],
    [0.1275, "0%", "13%"],
    [0.1275, "0.0%", "12.8%"],
    [0.1275, "0.00%", "12.75%"],
    [1, "0%", "100%"],
    [1234567, "#,##0,", "1,235"],
    [1234567, "0.0,,", "1.2"],
    [1234567, '0.0,,"M"', "1.2M"],
    [123456789, "000-00-0000", "123-45-6789"],
    [5551234, "000-0000", "555-1234"],
    [1e15, "#,##0", "1,000,000,000,000,000"],
    [1e21, "0", "1000000000000000000000"],
  ])("formats %d with %s as %j", (value, code, expected) => {
    expect(formatValue(value, code)).toBe(expected);
  });
});

describe("scientific", () => {
  it.each<[number, string, string]>([
    [0.000123, "0.00E+00", "1.23E-04"],
    [123456, "0.00E+00", "1.23E+05"],
    [0, "0.00E+00", "0.00E+00"],
    [-123456, "0.00E+00", "-1.23E+05"],
    [9.999, "0.00E+00", "1.00E+01"],
    [123456, "0.0E-0", "1.2E5"],
    [0.00012, "0.0E-0", "1.2E-4"],
    [12345, "##0.0E+0", "12.3E+3"],
    [1, "0E+0", "1E+0"],
  ])("formats %d with %s as %j", (value, code, expected) => {
    expect(formatValue(value, code)).toBe(expected);
  });
});

describe("currency, literals and sections", () => {
  it.each<[CellValue, string, string]>([
    [1234.5, '"$"#,##0.00_);[Red]("$"#,##0.00)', "$1,234.50 "],
    [-1234.5, '"$"#,##0.00_);[Red]("$"#,##0.00)', "($1,234.50)"],
    [-987.65, '"£"#,##0.00', "-£987.65"],
    [50000, "#,##0.00 [$€-x-euro2]", "50,000.00 €"],
    [1234, "[$$-409]#,##0.00", "$1,234.00"],
    [1234, "[$-409]#,##0", "1,234"],
    [5, "$0.00", "$5.00"],
    [-15000, "#,##0;[Red]-#,##0", "-15,000"],
    [15000, "#,##0;[Red]-#,##0", "15,000"],
    [0, '0.00;-0.00;"zero"', "zero"],
    [3, '0.00;-0.00;"zero"', "3.00"],
    [-3, '0.00;-0.00;"zero"', "-3.00"],
    [-3, "0.00;(0.00)", "(3.00)"],
    ["abc", '0.00;-0.00;0;"<"@">"', "<abc>"],
    ["abc", "0.00", "abc"],
    ["007", "@", "007"],
    ["x", '"Name: "@', "Name: x"],
    [12, "@", "12"],
    [5, '0" units"', "5 units"],
    [5, "0\\ \\k\\g", "5 kg"],
    [5, "0*-", "5"],
    [5, '"N/A"', "N/A"],
    [150, "[>100]0.0;0", "150.0"],
    [50, "[>100]0.0;0", "50"],
    [50, '[<10]"low";[<100]"mid";"high"', "mid"],
    [500, '[<10]"low";[<100]"mid";"high"', "high"],
    [true, "0.00", "TRUE"],
    [NA, "0.00", "#N/A"],
    [null, "0.00", ""],
  ])("formats %j with %s as %j", (value, code, expected) => {
    expect(formatValue(value, code)).toBe(expected);
  });

  it("reports the section colour", () => {
    expect(formatValueDetailed(-15000, "#,##0;[Red]-#,##0")).toEqual({ text: "-15,000", color: "#ff0000" });
    expect(formatValueDetailed(15000, "#,##0;[Red]-#,##0")).toEqual({ text: "15,000", color: null });
    expect(formatValueDetailed(1, "[Blue]0;[Color 3]-0")).toEqual({ text: "1", color: "#0000ff" });
    expect(formatValueDetailed(-1, "[Blue]0;[Color 3]-0")).toEqual({ text: "-1", color: "#ff0000" });
    expect(formatValueDetailed("t", "0;-0;0;[Green]@")).toEqual({ text: "t", color: "#00ff00" });
  });
});

describe("fractions", () => {
  it.each<[number, string, string]>([
    [0.75, "# ?/?", " 3/4"],
    [2.5, "# ?/?", "2 1/2"],
    [2, "# ?/?", "2    "],
    [0.3333333, "# ?/?", " 1/3"],
    [3.14159, "# ??/??", "3 14/99"],
    [0.75, "?/?", "3/4"],
    [1.75, "?/?", "7/4"],
    [0.375, "# ?/8", " 3/8"],
    [0.999, "# ?/?", "1    "],
  ])("formats %d with %s as %j", (value, code, expected) => {
    expect(formatValue(value, code)).toBe(expected);
  });
});

describe("dates and times", () => {
  // 46095 is 2026-03-14 (a Saturday); .63155092593 is 15:09:26.
  it.each<[number, string, string]>([
    [46095, "yyyy-mm-dd", "2026-03-14"],
    [46095.63155092593, "yyyy-mm-dd h:mm:ss", "2026-03-14 15:09:26"],
    [46095.63155092593, "yyyy-mm-dd hh:mm", "2026-03-14 15:09"],
    [46381, "d mmmm yyyy", "25 December 2026"],
    [46095, "d-mmm-yy", "14-Mar-26"],
    [46095, "mmm d, yyyy", "Mar 14, 2026"],
    [46095, "dddd, mmmm d", "Saturday, March 14"],
    [46095, "ddd", "Sat"],
    [46095, "mmmmm", "M"],
    [46095, "m/d/yy", "3/14/26"],
    [46095, "mm/dd/yyyy", "03/14/2026"],
    [46095, "yy", "26"],
    [0.6041666666666666, "h:mm AM/PM", "2:30 PM"],
    [0.6041666666666666, "hh:mm", "14:30"],
    [0.5, "h:mm AM/PM", "12:00 PM"],
    [0, "h:mm AM/PM", "12:00 AM"],
    [0.25, "h:mm:ss A/P", "6:00:00 A"],
    [0.75, "h AM/PM", "6 PM"],
    [1.5, "[h]:mm", "36:00"],
    [1.5, "[h]:mm:ss", "36:00:00"],
    [0.5, "[m]", "720"],
    [0.001, "[s]", "86"],
    [0.5 + 1.5 / 86400, "h:mm:ss.0", "12:00:01.5"],
    [0.5 + 1.25 / 86400, "mm:ss.00", "00:01.25"],
    [0.999999, "h:mm:ss", "0:00:00"],
    [0.99999, "h:mm:ss", "23:59:59"],
    [46095.99999999, "yyyy-mm-dd hh:mm:ss", "2026-03-15 00:00:00"],
    [1, "yyyy-mm-dd", "1900-01-01"],
    [59, "yyyy-mm-dd", "1900-02-28"],
    [60, "yyyy-mm-dd", "1900-02-29"],
    [61, "yyyy-mm-dd", "1900-03-01"],
    [0, "yyyy-mm-dd", "1900-01-00"],
    [1, "dddd", "Sunday"],
    [-1, "yyyy-mm-dd", "#####"],
    [46095, 'yyyy"年"m"月"d"日"', "2026年3月14日"],
  ])("formats %d with %s as %j", (value, code, expected) => {
    expect(formatValue(value, code)).toBe(expected);
  });

  it("uses the 1904 date system when asked", () => {
    expect(formatValue(0, "yyyy-mm-dd", { date1904: true })).toBe("1904-01-01");
    expect(formatValue(44633, "yyyy-mm-dd", { date1904: true })).toBe("2026-03-14");
    expect(formatValue(0, "dddd", { date1904: true })).toBe("Friday");
  });

  it("keeps text as it is under a date format", () => {
    expect(formatValue("soon", "yyyy-mm-dd")).toBe("soon");
  });
});

describe("format helpers", () => {
  it("knows the built-in number formats", () => {
    expect(builtinFormatCode(0)).toBe("General");
    expect(builtinFormatCode(2)).toBe("0.00");
    expect(builtinFormatCode(9)).toBe("0%");
    expect(builtinFormatCode(14)).toBe("mm-dd-yy");
    expect(builtinFormatCode(49)).toBe("@");
    expect(builtinFormatCode(163)).toBeNull();
  });

  it("recognises date formats", () => {
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat("h:mm AM/PM")).toBe(true);
    expect(isDateFormat("[h]:mm")).toBe(true);
    expect(isDateFormat("0.00")).toBe(false);
    expect(isDateFormat("General")).toBe(false);
    expect(isDateFormat('"day "0')).toBe(false);
    expect(isDateFormat("[Red]0;[Blue]-0")).toBe(false);
    expect(isDateFormat("@")).toBe(false);
  });

  it("survives malformed codes without throwing", () => {
    expect(formatValue(5, '"unterminated')).toBe("unterminated");
    expect(formatValue(5, "[Red")).toBe("5");
    expect(formatValue(5, "")).toBe("5");
    expect(formatValue(5, "0\\")).toBe("5");
    expect(typeof formatValue(5, ";;;")).toBe("string");
  });
});
