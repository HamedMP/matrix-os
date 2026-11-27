/**
 * Cash flow functions: NPV and IRR for evenly spaced flows, XNPV and XIRR
 * for flows on given dates (discounted by actual days over 365).
 */

import type { FormulaArg, FormulaError, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, collectNumbers, flattenValues, isError } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { dayArg } from "../date/serial.js";
import { numberArg } from "../text/args.js";
import { solveRate } from "./solve.js";

function npv(args: readonly FormulaArg[]): FormulaValue {
  const rate = numberArg(args[0]);
  if (isError(rate)) return rate;
  const values = collectNumbers(args.slice(1));
  if (isError(values)) return values;
  if (rate === -1) return ERR.DIV0;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += (values[i] as number) / (1 + rate) ** (i + 1);
  return total;
}

function hasBothSigns(values: readonly number[]): boolean {
  return values.some((v) => v > 0) && values.some((v) => v < 0);
}

function irr(args: readonly FormulaArg[]): FormulaValue {
  const values = collectNumbers([args[0] ?? null]);
  if (isError(values)) return values;
  const guess = numberArg(args[1], 0.1);
  if (isError(guess)) return guess;
  if (!hasBothSigns(values)) return ERR.NUM;
  const f = (r: number): number => {
    let total = 0;
    for (let i = 0; i < values.length; i += 1) total += (values[i] as number) / (1 + r) ** i;
    return total;
  };
  const df = (r: number): number => {
    let total = 0;
    for (let i = 1; i < values.length; i += 1) total -= (i * (values[i] as number)) / (1 + r) ** (i + 1);
    return total;
  };
  const root = solveRate(f, guess, df);
  return root === null ? ERR.NUM : root;
}

interface DatedFlows {
  values: number[];
  /** Days after the first date. */
  offsets: number[];
}

/** Values and dates of XNPV and XIRR: equal counts, numbers only, no date before the first. */
function datedFlows(valuesArg: FormulaArg | undefined, datesArg: FormulaArg | undefined, context: FunctionContext): DatedFlows | FormulaError {
  const valueCells = flattenValues(valuesArg ?? null);
  const dateCells = flattenValues(datesArg ?? null);
  const values: number[] = [];
  for (const cell of valueCells) {
    if (isError(cell)) return cell;
    if (typeof cell !== "number") return ERR.VALUE;
    values.push(cell);
  }
  const days: number[] = [];
  for (const cell of dateCells) {
    if (isError(cell)) return cell;
    if (cell === null || typeof cell === "boolean") return ERR.VALUE;
    const day = dayArg(cell, context);
    if (isError(day)) return day;
    days.push(day);
  }
  if (values.length === 0 || values.length !== days.length) return ERR.NUM;
  const first = days[0] as number;
  if (days.some((day) => day < first)) return ERR.NUM;
  return { values, offsets: days.map((day) => day - first) };
}

function xnpvAt(flows: DatedFlows, rate: number): number {
  let total = 0;
  for (let i = 0; i < flows.values.length; i += 1) {
    total += (flows.values[i] as number) / (1 + rate) ** ((flows.offsets[i] as number) / 365);
  }
  return total;
}

function xnpv(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const rate = numberArg(args[0]);
  if (isError(rate)) return rate;
  const flows = datedFlows(args[1], args[2], context);
  if (isError(flows)) return flows;
  if (rate <= -1) return ERR.NUM;
  return xnpvAt(flows, rate);
}

function xirr(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const flows = datedFlows(args[0], args[1], context);
  if (isError(flows)) return flows;
  const guess = numberArg(args[2], 0.1);
  if (isError(guess)) return guess;
  if (!hasBothSigns(flows.values)) return ERR.NUM;
  const df = (r: number): number => {
    let total = 0;
    for (let i = 0; i < flows.values.length; i += 1) {
      const t = (flows.offsets[i] as number) / 365;
      total -= (t * (flows.values[i] as number)) / (1 + r) ** (t + 1);
    }
    return total;
  };
  const root = solveRate((r) => xnpvAt(flows, r), guess, df);
  return root === null ? ERR.NUM : root;
}

/** Registers NPV, IRR, XNPV and XIRR. */
export function registerCashFlowFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "NPV", npv, { minArgs: 2, maxArgs: 255, ranges: (i) => i > 0 });
  registerFunction(registry, "IRR", irr, { minArgs: 1, maxArgs: 2, ranges: [0] });
  registerFunction(registry, "XNPV", xnpv, { minArgs: 3, maxArgs: 3, ranges: [1, 2] });
  registerFunction(registry, "XIRR", xirr, { minArgs: 2, maxArgs: 3, ranges: [0, 1] });
}
