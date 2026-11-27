/**
 * Time value of money: PMT, IPMT, PPMT, PV, FV, NPER, RATE and SLN.
 *
 * Sign convention: money paid out is negative, money received positive.
 * `type` 0 (default) pays at the end of each period, any other value at
 * the start. Every function solves the annuity equation
 *
 *   pv·(1+r)^n + pmt·(1+r·type)·((1+r)^n − 1)/r + fv = 0
 *
 * which for r = 0 becomes pv + pmt·n + fv = 0.
 */

import type { FormulaArg, FormulaError, FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, isError } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { numberArg } from "../text/args.js";
import { solveRate } from "./solve.js";

/** Reads numeric arguments; `defaults[i]` applies when argument i is left out (undefined means required). */
function numbers(args: readonly FormulaArg[], defaults: ReadonlyArray<number | undefined>): number[] | FormulaError {
  const out: number[] = [];
  for (let i = 0; i < defaults.length; i += 1) {
    const n = numberArg(args[i], defaults[i]);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

function due(type: number): number {
  return type !== 0 ? 1 : 0;
}

export function pmtValue(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) return -(pv + fv) / nper;
  const growth = (1 + rate) ** nper;
  return (-rate * (fv + pv * growth)) / ((1 + rate * due(type)) * (growth - 1));
}

export function fvValue(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + pmt * nper);
  const growth = (1 + rate) ** nper;
  return -(pv * growth + (pmt * (1 + rate * due(type)) * (growth - 1)) / rate);
}

function pvValue(rate: number, nper: number, pmt: number, fv: number, type: number): number {
  if (rate === 0) return -(fv + pmt * nper);
  const growth = (1 + rate) ** nper;
  return -(fv + (pmt * (1 + rate * due(type)) * (growth - 1)) / rate) / growth;
}

/** Interest part of payment `per` (1-based). */
function ipmtValue(rate: number, per: number, nper: number, pv: number, fv: number, type: number): number {
  const payment = pmtValue(rate, nper, pv, fv, type);
  let interest: number;
  if (per === 1) interest = due(type) === 1 ? 0 : -pv;
  else if (due(type) === 1) interest = fvValue(rate, per - 2, payment, pv, 1) - payment;
  else interest = fvValue(rate, per - 1, payment, pv, 0);
  return interest * rate;
}

function finite(n: number): number | FormulaError {
  return Number.isFinite(n) ? n : ERR.NUM;
}

function pmt(args: readonly FormulaArg[]): FormulaValue {
  const v = numbers(args, [undefined, undefined, undefined, 0, 0]);
  if (isError(v)) return v;
  const [rate, nper, pv, fv, type] = v as [number, number, number, number, number];
  if (nper === 0) return ERR.NUM;
  return finite(pmtValue(rate, nper, pv, fv, type));
}

function periodPart(principal: boolean): (args: readonly FormulaArg[]) => FormulaValue {
  return (args) => {
    const v = numbers(args, [undefined, undefined, undefined, undefined, 0, 0]);
    if (isError(v)) return v;
    const [rate, per, nper, pv, fv, type] = v as [number, number, number, number, number, number];
    if (per < 1 || per > nper || nper === 0) return ERR.NUM;
    const interest = ipmtValue(rate, per, nper, pv, fv, type);
    return finite(principal ? pmtValue(rate, nper, pv, fv, type) - interest : interest);
  };
}

function pv(args: readonly FormulaArg[]): FormulaValue {
  const v = numbers(args, [undefined, undefined, undefined, 0, 0]);
  if (isError(v)) return v;
  const [rate, nper, payment, fv, type] = v as [number, number, number, number, number];
  return finite(pvValue(rate, nper, payment, fv, type));
}

function fv(args: readonly FormulaArg[]): FormulaValue {
  const v = numbers(args, [undefined, undefined, undefined, 0, 0]);
  if (isError(v)) return v;
  const [rate, nper, payment, present, type] = v as [number, number, number, number, number];
  return finite(fvValue(rate, nper, payment, present, type));
}

function nper(args: readonly FormulaArg[]): FormulaValue {
  const v = numbers(args, [undefined, undefined, undefined, 0, 0]);
  if (isError(v)) return v;
  const [rate, payment, present, future, type] = v as [number, number, number, number, number];
  if (rate === 0) return payment === 0 ? ERR.NUM : finite(-(present + future) / payment);
  const adjusted = payment * (1 + rate * due(type));
  const ratio = (adjusted - future * rate) / (adjusted + present * rate);
  if (!(ratio > 0) || 1 + rate <= 0) return ERR.NUM;
  return finite(Math.log(ratio) / Math.log(1 + rate));
}

/** The annuity equation's left-hand side as a function of the rate. */
function annuityBalance(nperValue: number, payment: number, present: number, future: number, type: number): (r: number) => number {
  return (r) => {
    if (Math.abs(r) < 1e-12) return present + payment * nperValue + future;
    const growth = (1 + r) ** nperValue;
    return present * growth + (payment * (1 + r * due(type)) * (growth - 1)) / r + future;
  };
}

function rate(args: readonly FormulaArg[]): FormulaValue {
  const v = numbers(args, [undefined, undefined, undefined, 0, 0, 0.1]);
  if (isError(v)) return v;
  const [periods, payment, present, future, type, guess] = v as [number, number, number, number, number, number];
  if (periods <= 0) return ERR.NUM;
  const root = solveRate(annuityBalance(periods, payment, present, future, type), guess);
  return root === null ? ERR.NUM : root;
}

function sln(args: readonly FormulaArg[]): FormulaValue {
  const v = numbers(args, [undefined, undefined, undefined]);
  if (isError(v)) return v;
  const [cost, salvage, life] = v as [number, number, number];
  if (life === 0) return ERR.DIV0;
  return (cost - salvage) / life;
}

/** Registers PMT, IPMT, PPMT, PV, FV, NPER, RATE and SLN. */
export function registerTimeValueFunctions(registry: FunctionRegistry): void {
  const scalar = { ranges: "none" as const };
  registerFunction(registry, "PMT", pmt, { minArgs: 3, maxArgs: 5, ...scalar });
  registerFunction(registry, "IPMT", periodPart(false), { minArgs: 4, maxArgs: 6, ...scalar });
  registerFunction(registry, "PPMT", periodPart(true), { minArgs: 4, maxArgs: 6, ...scalar });
  registerFunction(registry, "PV", pv, { minArgs: 3, maxArgs: 5, ...scalar });
  registerFunction(registry, "FV", fv, { minArgs: 3, maxArgs: 5, ...scalar });
  registerFunction(registry, "NPER", nper, { minArgs: 3, maxArgs: 5, ...scalar });
  registerFunction(registry, "RATE", rate, { minArgs: 3, maxArgs: 6, ...scalar });
  registerFunction(registry, "SLN", sln, { minArgs: 3, maxArgs: 3, ...scalar });
}
