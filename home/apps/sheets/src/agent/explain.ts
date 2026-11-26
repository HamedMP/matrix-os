/**
 * Plain-language answers: explaining a formula or a range, and narrating a
 * trace that code has already walked. The model's text is only shown; it
 * never changes the workbook.
 */

import { askAboutWorkbook } from "./ai";
import { type AgentContext, type ExplainOutcome, type SheetSelection } from "./context";
import { type CellAddress, type SheetId, type Workbook, describeSheet, formatA1, formatA1Range } from "./engine";
import { MAX_ANSWER_CHARS } from "./limits";
import { buildPrompt, contentBudget } from "./prompt";
import { type Trace, directPrecedents, traceText, traceValue } from "./trace";
import { clip, stripControlChars } from "./untrusted";

const ANSWER_RULES = [
  "Answer in plain language for someone who does not write formulas, in at most eight short sentences or bullet points.",
  "Refer to cells by their address, for example Summary!B2. Do not propose changes and do not answer in JSON.",
];

/** The model's text as the panel shows it: no control characters, no code fences, bounded. */
export function cleanAnswer(text: string): string {
  const bare = stripControlChars(text).replace(/^```[a-z]*\s*|```\s*$/gi, "").trim();
  return clip(bare === "" ? "The assistant gave no explanation." : bare, MAX_ANSWER_CHARS);
}

function locationOf(workbook: Workbook, sheet: SheetId, address: CellAddress): string {
  return `${workbook.getSheet(sheet).name}!${formatA1(address)}`;
}

/** The formula cell and the cells it reads, one per line. */
function formulaContext(workbook: Workbook, sheet: SheetId, address: CellAddress, maxChars: number): string {
  const cell = workbook.getCell(sheet, address);
  const lines = [`${locationOf(workbook, sheet, address)} = ${cell.formula ?? ""} => ${cell.display}`, "It reads:"];
  let length = lines.join("\n").length;
  for (const ref of directPrecedents(workbook, sheet, { start: address, end: address })) {
    const source = workbook.getCell(ref.sheet, ref);
    const text = `${locationOf(workbook, ref.sheet, ref)}: ${source.formula === null ? source.display : `=${source.formula} => ${source.display}`}`.replace(/[\r\n]+/g, " ");
    if (length + text.length + 1 > maxChars) {
      lines.push("…");
      break;
    }
    lines.push(text);
    length += text.length + 1;
  }
  return lines.join("\n");
}

/** Explains the formula of one cell, or what a range holds and how it is calculated. Highlights the cells it reads. */
export async function explainSelection(ctx: AgentContext, selection: SheetSelection): Promise<ExplainOutcome> {
  const workbook = ctx.session.workbook;
  const { sheet, range } = selection;
  const single = range.start.row === range.end.row && range.start.col === range.end.col;
  const cell = single ? workbook.getCell(sheet, range.start) : null;
  const subject = single ? locationOf(workbook, sheet, range.start) : `${workbook.getSheet(sheet).name}!${formatA1Range(range)}`;
  const isFormula = cell !== null && cell.formula !== null;
  const parts = {
    task: isFormula
      ? `Explain what the formula in ${formatA1(range.start)} calculates, step by step, and what its result means.`
      : `Explain what the cells ${formatA1Range(range)} hold and how the formulas among them are calculated.`,
    rules: ANSWER_RULES,
  };
  const label = isFormula ? "Formula and its inputs" : "Selected cells";
  const budget = Math.max(1, contentBudget(parts, [label]));
  const text = isFormula ? formulaContext(workbook, sheet, range.start, budget) : describeSheet(workbook, sheet, range, { maxChars: budget }).text;
  const reply = await askAboutWorkbook(ctx, buildPrompt({ ...parts, blocks: [{ label, text }] }));
  return { text: cleanAnswer(reply), subject, highlights: directPrecedents(workbook, sheet, range) };
}

/** Traces a value to its sources in code, then asks the model to narrate the trace. */
export async function narrateTrace(ctx: AgentContext, sheet: SheetId, address: CellAddress): Promise<ExplainOutcome & { trace: Trace }> {
  const workbook = ctx.session.workbook;
  const trace = traceValue(workbook, sheet, address);
  const subject = trace.root.location;
  if (trace.root.kind !== "formula") {
    return { trace, subject, highlights: trace.cells, text: `${subject} is a typed-in value, not a formula: it is its own source.` };
  }
  const parts = {
    task: `Narrate where the value of ${subject} comes from, following the trace below from the cell down to its typed-in inputs. Name the inputs that drive it most.`,
    rules: [...ANSWER_RULES, "The trace was computed by the app and is complete unless it says it was shortened; do not invent cells that are not in it."],
  };
  const label = `Trace of ${subject}`;
  const text = traceText(trace, Math.max(1, contentBudget(parts, [label])));
  const reply = await askAboutWorkbook(ctx, buildPrompt({ ...parts, blocks: [{ label, text }] }));
  return { trace, subject, highlights: trace.cells, text: cleanAnswer(reply) };
}
