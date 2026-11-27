import { describe, expect, it } from "vitest";
import type { FormulaError, FormulaScalar } from "../../../../../packages/office/src/api/formula.js";
import { wildcardMatcher, wildcardSearch } from "../../../../../packages/office/src/xlsx/formula/functions/text/index.js";
import { err, setup } from "./setup.js";

describe("text functions", () => {
  const { value, rows } = setup();

  it.each<[string, FormulaScalar]>([
    ['CONCAT("a",1,TRUE)', "a1TRUE"],
    ["CONCAT(A1:A3)", "123"],
    ['CONCAT(B1:B2,"-",E1:G1)', "appleBanana-xyz"],
    ['CONCATENATE("a",2.5,"b")', "a2.5b"],
    ["CONCATENATE(D7,\"x\")", "x"],
    ['TEXTJOIN(", ",TRUE,"a","","b",D7,"c")', "a, b, c"],
    ['TEXTJOIN("-",FALSE,"a","","b")', "a--b"],
    ['TEXTJOIN({"+","-"},TRUE,1,2,3,4)', "1+2-3+4"],
    ["TEXTJOIN(\"/\",TRUE,A1:A3)", "1/2/3"],
    ['LEFT("hello",2)', "he"],
    ['LEFT("hello")', "h"],
    ['LEFT("hi",10)', "hi"],
    ['LEFT("hello",0)', ""],
    ['LEFT("hello",)', ""],
    ['RIGHT("hello",D7)', ""],
    ['RIGHT("hello",3)', "llo"],
    ['RIGHT("hello")', "o"],
    ['RIGHT("hello",0)', ""],
    ['MID("spreadsheet",3,4)', "read"],
    ['MID("abc",5,2)', ""],
    ["LEN(\"hello\")", 5],
    ["LEN(123.5)", 5],
    ["LEN(D7)", 0],
    ['LOWER("HeLLo")', "hello"],
    ['UPPER("straße")', "STRASSE"],
    ['PROPER("hello wORLD 2-way o\'neil")', "Hello World 2-Way O'Neil"],
    ['TRIM("  a   b  c ")', "a b c"],
    ['SUBSTITUTE("a-b-c","-","+")', "a+b+c"],
    ['SUBSTITUTE("a-b-c","-","+",2)', "a-b+c"],
    ['SUBSTITUTE("a-b-c","-","+",5)', "a-b-c"],
    ['SUBSTITUTE("aaa","aa","b",2)', "aaa"],
    ['SUBSTITUTE("Abc","a","x")', "Abc"],
    ['SUBSTITUTE("abc","","x")', "abc"],
    ['REPLACE("abcdef",2,3,"XY")', "aXYef"],
    ['REPLACE("abc",10,1,"Z")', "abcZ"],
    ['FIND("b","abcb")', 2],
    ['FIND("b","abcb",3)', 4],
    ['FIND("","abc",2)', 2],
    ['SEARCH("B","abcb")', 2],
    ['SEARCH("b?d","xxabdcbcd")', 7],
    ['SEARCH("b?d","xxabcdbcd")', 4],
    ['SEARCH("c*d","abxcyyd")', 4],
    ['SEARCH("~*","a*b")', 2],
    ['SEARCH("~?","what?")', 5],
    ['REPT("ab",3)', "ababab"],
    ['REPT("ab",0)', ""],
    ['EXACT("abc","abc")', true],
    ['EXACT("abc","ABC")', false],
    ["EXACT(1,\"1\")", true],
    ["CHAR(65)", "A"],
    ["CHAR(128)", "€"],
    ['CODE("A")', 65],
    ['CODE("abc")', 97],
    ['CODE("€")', 128],
    ['CODE("中")', 63],
    ['T("x")', "x"],
    ["T(1)", ""],
    ["T(B1)", "apple"],
    ['VALUE("1,234.5")', 1234.5],
    ['VALUE("50%")', 0.5],
    ['VALUE("(42)")', -42],
    ['VALUE("$12")', 12],
    ['VALUE("2024-01-15")', 45306],
    ['VALUE("1/15/2024")', 45306],
    ['VALUE("18:00")', 0.75],
    ["VALUE(7)", 7],
    ["FIXED(1234.567)", "1,234.57"],
    ["FIXED(1234.567,1,TRUE)", "1234.6"],
    ["FIXED(-1234.567,0)", "-1,235"],
    ["FIXED(1234.567,-2)", "1,200"],
    ["FIXED(2.5,0)", "3"],
    ["FIXED(1.005,2)", "1.01"],
    ["FIXED(0.004,2)", "0.00"],
    ["DOLLAR(1234.567)", "$1,234.57"],
    ["DOLLAR(-0.5,1)", "($0.5)"],
    ["DOLLAR(99,0)", "$99"],
    ['TEXT(1234.5,"#,##0.00")', "1,234.50"],
    ['TEXT(0.25,"0%")', "25%"],
    ['TEXT(45306,"yyyy-mm-dd")', "2024-01-15"],
    ['TEXT("3","0.0")', "3.0"],
    ['TEXT("abc","0.0")', "abc"],
    ['TEXT(D7,"0")', "0"],
  ])("%s is %j", (text, expected) => {
    expect(value(text)).toBe(expected);
  });

  it.each<[string, FormulaError["code"]]>([
    ['LEFT("abc",-1)', "#VALUE!"],
    ['RIGHT("abc",-1)', "#VALUE!"],
    ['MID("abc",0,1)', "#VALUE!"],
    ['MID("abc",1,-1)', "#VALUE!"],
    ['SUBSTITUTE("a","a","b",0)', "#VALUE!"],
    ['REPLACE("a",0,1,"b")', "#VALUE!"],
    ['FIND("B","abc")', "#VALUE!"],
    ['FIND("a","abc",0)', "#VALUE!"],
    ['FIND("a","abc",5)', "#VALUE!"],
    ['SEARCH("z","abc")', "#VALUE!"],
    ['REPT("a",-1)', "#VALUE!"],
    ['REPT("abc",20000)', "#VALUE!"],
    ["CHAR(0)", "#VALUE!"],
    ["CHAR(256)", "#VALUE!"],
    ['CODE("")', "#VALUE!"],
    ['VALUE("abc")', "#VALUE!"],
    ["VALUE(TRUE)", "#VALUE!"],
    ["LEN(1/0)", "#DIV/0!"],
    ['CONCAT("a",#N/A)', "#N/A"],
    ['TEXTJOIN(",",TRUE,"a",1/0)', "#DIV/0!"],
    ['UPPER(#N/A)', "#N/A"],
    ["T(#REF!)", "#REF!"],
    ["FIXED(1,128)", "#VALUE!"],
    ['FIXED("x")', "#VALUE!"],
    ['TEXT(1/0,"0")', "#DIV/0!"],
    ["LEFT()", "#VALUE!"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code));
  });

  // Fault detected: a range read from a sheet holds values only up to the used part of the sheet, so TEXTJOIN that
  // keeps empty cells left out the delimiters of the blank cells after the last value.
  it("keeps every blank cell of a reference when TEXTJOIN does not ignore empty cells", () => {
    expect(value('TEXTJOIN(",",FALSE,A5:A10)')).toBe("8,,,,,");
    // Columns past the used part of the sheet count too, in the order of the cells.
    expect(value('TEXTJOIN({",",";"},FALSE,K1:N2)')).toBe("-70000,A1;,;12000,Other!B2;,");
    expect(value('TEXTJOIN(",",TRUE,A5:A10)')).toBe("8");
    // A whole column of delimiters is longer than a cell holds; with no delimiter the blanks add nothing.
    expect(value('TEXTJOIN(",",FALSE,A:A)')).toEqual(err("#VALUE!"));
    expect(value('TEXTJOIN("",FALSE,A:A)')).toBe("12358");
  });

  it("applies scalar text functions element by element to ranges", () => {
    expect(rows("UPPER(B1:B3)")).toEqual([["APPLE"], ["BANANA"], ["CHERRY"]]);
    expect(rows('LEFT(B1:B2,{1,2})')).toEqual([["a", "ap"], ["B", "Ba"]]);
  });

  it("prefers the workbook formatter for TEXT when the context supplies one", () => {
    const custom = setup({ formatValue: (v, code) => `[${String(v)}|${code}]` });
    expect(custom.value('TEXT(12,"0.0")')).toBe("[12|0.0]");
    expect(custom.value('TEXT("7","0")')).toBe("[7|0]");
  });

  it("matches wildcards without regular expressions", () => {
    expect(wildcardMatcher("a*c")("ABBBC")).toBe(true);
    expect(wildcardMatcher("a?c")("abbc")).toBe(false);
    expect(wildcardMatcher("~*")("*")).toBe(true);
    expect(wildcardMatcher("~*")("a")).toBe(false);
    expect(wildcardMatcher("*")("")).toBe(true);
    expect(wildcardSearch("b*", "abc", 0)).toBe(1);
    expect(wildcardSearch("q", "abc", 0)).toBe(-1);
    const long = `${"a".repeat(5000)}b`;
    expect(wildcardMatcher(`${"*a".repeat(20)}*c`)(long)).toBe(false);
  });
});
