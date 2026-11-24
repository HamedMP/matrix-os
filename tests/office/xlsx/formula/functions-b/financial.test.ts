import { describe, expect, it } from "vitest";
import type { FormulaError } from "../../../../../packages/office/src/api/formula.js";
import { solveRate } from "../../../../../packages/office/src/xlsx/formula/functions/financial/index.js";
import { err, setup } from "./setup.js";

/**
 * Expected values are derived by hand from the annuity equation, for
 * example PMT(10%, 2, 1000): p/1.1 + p/1.21 = 1000, so p = 576.190476…,
 * paid out (negative). Two-period cases are worked out in the comments.
 */
const P2 = 1000 / (1 / 1.1 + 1 / 1.21); // 576.1904761904762: level payment repaying 1000 over two periods at 10%.
const P2_DUE = 1000 / (1 + 1 / 1.1); // 523.8095238095239: the same, paid at the start of each period.

describe("financial functions", () => {
  const { value } = setup();

  it.each<[string, number]>([
    ["PMT(0.1,2,1000)", -P2],
    ["PMT(0.1,2,1000,0,1)", -P2_DUE],
    ["PMT(0,4,1000)", -250],
    ["PMT(0,4,1000,200)", -300],
    ["PMT(0.1,1,0,-110)", 110],
    // Published worked example: 10 000 over 10 months at 8% a year.
    ["PMT(0.08/12,10,10000)", -1037.0320893591606],
    // 100 paid at the end of two periods, 10% growth: 100·1.1 + 100.
    ["FV(0.1,2,-100)", 210],
    // At the start of each period: 100·1.21 + 100·1.1.
    ["FV(0.1,2,-100,0,1)", 231],
    ["FV(0.1,2,0,-1000)", 1210],
    ["FV(0,3,-10,-5)", 35],
    // 100/1.1 + 100/1.21.
    ["PV(0.1,2,-100)", 100 / 1.1 + 100 / 1.21],
    ["PV(0.1,2,-100,0,1)", 100 + 100 / 1.1],
    ["PV(0,5,-10)", 50],
    ["PV(0.1,1,0,-110)", 100],
    ["NPER(0.1,-576.1904761904762,1000)", 2],
    ["NPER(0,-100,1000)", 10],
    ["NPER(0.1,0,-100,121)", 2],
    // Published worked example.
    ["NPER(0.12/12,-100,-1000,10000,1)", 59.67386567429457],
    ["RATE(2,-576.1904761904762,1000)", 0.1],
    ["RATE(2,0,-100,121)", 0.1],
    ["RATE(2,-523.8095238095239,1000,0,1)", 0.1],
    ["RATE(10,-100,1000)", 0],
    // Published worked example: 8000 repaid by 48 monthly payments of 200.
    ["RATE(4*12,-200,8000)", 0.007701472488201564],
    // First period interest on 1000 at 10%; second period on 1000·1.1 − 576.19 = 523.81.
    ["IPMT(0.1,1,2,1000)", -100],
    ["IPMT(0.1,2,2,1000)", -(1100 - P2) * 0.1],
    ["IPMT(0.1,1,2,1000,0,1)", 0],
    ["IPMT(0.1,2,2,1000,0,1)", -(1000 - P2_DUE) * 0.1],
    ["PPMT(0.1,1,2,1000)", -P2 + 100],
    ["PPMT(0.1,2,2,1000)", -P2 + (1100 - P2) * 0.1],
    ["PPMT(0,2,4,1000)", -250],
    // 110 and 121 discounted one and two periods at 10%.
    ["NPV(0.1,110,121)", 200],
    ["NPV(0,1,2,3)", 6],
    ["NPV(0.1,{110,121})", 200],
    // Published worked example.
    ["NPV(0.1,-10000,3000,4200,6800)", 1188.4434123352207],
    ["IRR({-100,110})", 0.1],
    ["IRR({-100,0,121})", 0.1],
    // 1000 = 600x + 600x² with x = 1/(1+r).
    ["IRR({-1000,600,600})", 0.1306623862918075],
    ["IRR({-1000,600,600},0.5)", 0.1306623862918075],
    // Published worked example: -70 000 followed by five years of income.
    ["IRR(K1:K6)", 0.08663094803653162],
    ["IRR(K1:K6,-0.5)", 0.08663094803653162],
    // 1100 received 365 days later is worth 1000 at 10%.
    ["XNPV(0.1,{-1000,1100},{45292,45657})", 0],
    ["XIRR({-1000,1100},{45292,45657})", 0.1],
    ['XIRR({-1000,1100},{"2024-01-01","2024-12-31"})', 0.1],
    // Published worked example (dates 2008-01-01 … 2009-04-01).
    ["XNPV(0.09,{-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904})", 2086.647602031535],
    ["XIRR({-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904})", 0.3733625335188315],
    ["SLN(30000,7500,10)", 2250],
    ["SLN(100,120,4)", -5],
  ])("%s is %d", (text, expected) => {
    const result = value(text);
    expect(typeof result).toBe("number");
    expect(result as number).toBeCloseTo(expected, 7);
  });

  it.each<[string, FormulaError["code"]]>([
    ["PMT(0.1,0,1000)", "#NUM!"],
    ['PMT("x",1,1)', "#VALUE!"],
    ["PMT(0.1,2,1/0)", "#DIV/0!"],
    ["IPMT(0.1,3,2,1000)", "#NUM!"],
    ["IPMT(0.1,0,2,1000)", "#NUM!"],
    ["PPMT(0.1,3,2,1000)", "#NUM!"],
    ["NPER(0,0,1000)", "#NUM!"],
    ["NPER(0.1,-10,1000)", "#NUM!"],
    ["RATE(0,-100,1000)", "#NUM!"],
    ["RATE(2,100,1000)", "#NUM!"],
    ["NPV(-1,1)", "#DIV/0!"],
    ['NPV(0.1,"x")', "#VALUE!"],
    ["NPV(0.1,1,#N/A)", "#N/A"],
    ["IRR({-100,-10})", "#NUM!"],
    ["IRR({100,10})", "#NUM!"],
    ["IRR({-100,#DIV/0!})", "#DIV/0!"],
    ["XNPV(0.1,{-1000,1100},{45292})", "#NUM!"],
    ["XNPV(0.1,{-1000,1100},{45292,45000})", "#NUM!"],
    ['XNPV(0.1,{-1000,"x"},{45292,45300})', "#VALUE!"],
    ["XNPV(-1,{-1000,1100},{45292,45657})", "#NUM!"],
    ["XIRR({1000,1100},{45292,45657})", "#NUM!"],
    ["XIRR({-1000,1100},{45292,#N/A})", "#N/A"],
    ["SLN(1,0,0)", "#DIV/0!"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code));
  });

  it("satisfies the annuity equation between PMT, PV, FV, NPER and RATE", () => {
    for (const [rate, nper, pv, fv, type] of [
      [0.05, 12, 1000, 0, 0],
      [0.01, 360, 250_000, -10_000, 1],
      [0.2, 3, -500, 100, 0],
    ] as const) {
      const pmt = value(`PMT(${rate},${nper},${pv},${fv},${type})`) as number;
      expect(value(`PV(${rate},${nper},${pmt},${fv},${type})`) as number).toBeCloseTo(pv, 6);
      expect(value(`FV(${rate},${nper},${pmt},${pv},${type})`) as number).toBeCloseTo(fv, 6);
      expect(value(`NPER(${rate},${pmt},${pv},${fv},${type})`) as number).toBeCloseTo(nper, 6);
      expect(value(`RATE(${nper},${pmt},${pv},${fv},${type})`) as number).toBeCloseTo(rate, 8);
      let principal = 0;
      for (let per = 1; per <= nper; per += 1) principal += value(`PPMT(${rate},${per},${nper},${pv},${fv},${type})`) as number;
      // Payments at the start of a period leave the last balance one period before the future value falls due.
      expect(principal).toBeCloseTo(-(pv + (type === 1 ? fv / (1 + rate) : fv)), 6);
    }
  });

  it("finds a root by bracketing when Newton's method does not settle", () => {
    expect(solveRate((r) => r * r * r - 0.001, 5)).toBeCloseTo(0.1, 8);
    expect(solveRate((r) => Math.atan(r - 0.3), 3)).toBeCloseTo(0.3, 8);
    expect(solveRate(() => 1, 0.1)).toBeNull();
    expect(solveRate((r) => r, -2)).toBeNull();
  });
});
