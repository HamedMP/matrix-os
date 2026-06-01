import { describe, expect, it } from "vitest";
import { evaluate, tokenize } from "../../home/apps/calculator/src/calc-engine";

function ok(expr: string, opts?: { degrees?: boolean }): number {
  const r = evaluate(expr, opts);
  if (!r.ok) throw new Error(`expected ok for "${expr}" but got error: ${r.error}`);
  return r.value;
}

function err(expr: string): string {
  const r = evaluate(expr, { degrees: false });
  if (r.ok) throw new Error(`expected error for "${expr}" but got ${r.value}`);
  return r.error;
}

describe("calc-engine tokenizer", () => {
  it("tokenizes numbers, operators, and parens", () => {
    const tokens = tokenize("1 + 2 * (3 - 4)");
    expect(tokens.map((t) => t.type)).toEqual([
      "number",
      "op",
      "number",
      "op",
      "lparen",
      "number",
      "op",
      "number",
      "rparen",
    ]);
  });

  it("tokenizes decimals and scientific-ish floats", () => {
    expect(tokenize("3.14").map((t) => t.value)).toEqual(["3.14"]);
    expect(tokenize("0.5 + .5").length).toBe(3);
  });

  it("recognizes function and constant identifiers", () => {
    const tokens = tokenize("sin(pi)");
    expect(tokens[0]).toMatchObject({ type: "ident", value: "sin" });
    expect(tokens.some((t) => t.type === "ident" && t.value === "pi")).toBe(true);
  });
});

describe("calc-engine evaluation", () => {
  it("evaluates basic arithmetic", () => {
    expect(ok("1 + 1")).toBe(2);
    expect(ok("10 - 4")).toBe(6);
    expect(ok("6 * 7")).toBe(42);
    expect(ok("20 / 5")).toBe(4);
  });

  it("respects operator precedence", () => {
    expect(ok("1 + 2 * 3")).toBe(7);
    expect(ok("2 * 3 + 4")).toBe(10);
    expect(ok("10 - 2 * 3")).toBe(4);
    expect(ok("2 + 3 * 4 - 1")).toBe(13);
  });

  it("handles parentheses", () => {
    expect(ok("(1 + 2) * 3")).toBe(9);
    expect(ok("2 * (3 + (4 - 1))")).toBe(12);
    expect(ok("((2))")).toBe(2);
  });

  it("handles unary minus and plus", () => {
    expect(ok("-5")).toBe(-5);
    expect(ok("-5 + 3")).toBe(-2);
    expect(ok("3 * -2")).toBe(-6);
    expect(ok("-(2 + 3)")).toBe(-5);
    expect(ok("+7")).toBe(7);
    expect(ok("--3")).toBe(3);
  });

  it("handles exponentiation (right associative)", () => {
    expect(ok("2 ^ 3")).toBe(8);
    expect(ok("2 ^ 3 ^ 2")).toBe(512);
    expect(ok("-2 ^ 2")).toBe(-4); // unary binds looser than ^
    expect(ok("(-2) ^ 2")).toBe(4);
  });

  it("handles percent as a postfix operator", () => {
    expect(ok("50%")).toBeCloseTo(0.5, 10);
    expect(ok("200 * 10%")).toBeCloseTo(20, 10);
  });

  it("handles modulo via the mod keyword (% is percent, not modulo)", () => {
    expect(ok("10 mod 3")).toBe(1);
    expect(ok("10% * 3")).toBeCloseTo(0.3, 10); // % is postfix percent
  });

  it("evaluates functions", () => {
    expect(ok("sqrt(16)")).toBe(4);
    expect(ok("ln(e)")).toBeCloseTo(1, 10);
    expect(ok("log(1000)")).toBeCloseTo(3, 10);
    expect(ok("abs(-9)")).toBe(9);
    expect(ok("max(3, 7, 2)")).toBe(7);
    expect(ok("min(3, 7, 2)")).toBe(2);
  });

  it("evaluates trig in radians by default", () => {
    expect(ok("sin(0)")).toBeCloseTo(0, 10);
    expect(ok("cos(0)")).toBeCloseTo(1, 10);
  });

  it("evaluates trig in degrees when requested", () => {
    expect(ok("sin(90)", { degrees: true })).toBeCloseTo(1, 10);
    expect(ok("cos(180)", { degrees: true })).toBeCloseTo(-1, 10);
    expect(ok("tan(45)", { degrees: true })).toBeCloseTo(1, 10);
  });

  it("evaluates constants", () => {
    expect(ok("pi")).toBeCloseTo(Math.PI, 10);
    expect(ok("e")).toBeCloseTo(Math.E, 10);
    expect(ok("2 * pi")).toBeCloseTo(2 * Math.PI, 10);
  });

  it("evaluates factorial", () => {
    expect(ok("5!")).toBe(120);
    expect(ok("0!")).toBe(1);
    expect(ok("3! + 1")).toBe(7);
  });

  it("supports implicit multiplication with constants and parens", () => {
    expect(ok("2pi")).toBeCloseTo(2 * Math.PI, 10);
    expect(ok("2(3)")).toBe(6);
    expect(ok("(1+1)(2+2)")).toBe(8);
  });

  it("returns an error for divide by zero", () => {
    expect(err("1 / 0")).toMatch(/divide|infinit|zero/i);
    expect(err("5 / (2 - 2)")).toMatch(/divide|infinit|zero/i);
  });

  it("returns an error for malformed input", () => {
    expect(err("1 +")).toBeTruthy();
    expect(err("* 3")).toBeTruthy();
    expect(err("(1 + 2")).toMatch(/paren/i);
    expect(err("1 + )")).toBeTruthy();
    expect(err("sqrt")).toBeTruthy();
    expect(err("hello")).toBeTruthy();
    expect(err("")).toBeTruthy();
    expect(err("3 4")).toBeTruthy();
  });

  it("returns an error for unknown function", () => {
    expect(err("frobnicate(2)")).toMatch(/unknown|function/i);
  });

  it("rejects factorial of negatives and non-integers", () => {
    expect(err("(-1)!")).toBeTruthy();
    expect(err("2.5!")).toBeTruthy();
  });

  it("never throws regardless of input", () => {
    const inputs = ["", ")(", "1//2", "...", "@#$", "sin(", "1 2 3 +", "()"];
    for (const i of inputs) {
      expect(() => evaluate(i)).not.toThrow();
    }
  });
});
