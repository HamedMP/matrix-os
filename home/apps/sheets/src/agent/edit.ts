/**
 * Editing by instruction and building tables: the model proposes edits as
 * the engine's sheet envelope; code validates them against the live workbook
 * and records them in one reviewable proposal.
 */

import { askModel } from "./ai";
import { type EditScope, runProposal, validateReply, writeResolved } from "./apply";
import { type AgentContext, type ProposalOutcome, type SheetSelection, isoNow } from "./context";
import { type CellRange, type SheetId, type Workbook, agentEditInstructions, describeSheet, formatA1, formatA1Range } from "./engine";
import { type PromptBlock, type PromptParts, buildPrompt, contentBudget, cleanRequest } from "./prompt";
import { oneLine } from "./untrusted";

/** Most other sheets described next to the active one. */
const MAX_OTHER_SHEETS = 6;

function sheetLabel(workbook: Workbook, sheet: SheetId): string {
  return `Sheet "${oneLine(workbook.getSheet(sheet).name, 40)}"`;
}

/** The active sheet in full (as far as it fits), then short descriptions of the other sheets. */
export function sheetBlocks(workbook: Workbook, sheet: SheetId, parts: Omit<PromptParts, "blocks">, focus: CellRange | null = null): PromptBlock[] {
  const others = workbook.listSheets().filter((info) => info.id !== sheet && info.state === "visible").slice(0, MAX_OTHER_SHEETS);
  const labels = [sheetLabel(workbook, sheet), ...others.map((info) => sheetLabel(workbook, info.id))];
  const budget = contentBudget(parts, labels);
  if (budget <= 0) return [];
  const mainBudget = others.length === 0 ? budget : Math.max(1, Math.floor(budget * 0.7));
  const main = describeSheet(workbook, sheet, focus, { maxChars: mainBudget });
  const blocks: PromptBlock[] = [{ label: labels[0]!, text: main.text + (main.truncated ? "\n(more rows not shown)" : "") }];
  let left = budget - main.text.length;
  for (let i = 0; i < others.length && left > 200; i++) {
    const share = Math.max(200, Math.floor(left / (others.length - i)));
    const other = describeSheet(workbook, others[i]!.id, null, { maxChars: Math.min(share, left) });
    blocks.push({ label: labels[i + 1]!, text: other.text + (other.truncated ? "\n(more rows not shown)" : "") });
    left -= other.text.length;
  }
  return blocks;
}

function selectionLine(workbook: Workbook, selection: SheetSelection | null): string {
  if (selection === null) return "";
  return `The owner has selected ${formatA1Range(selection.range)} on the sheet ${JSON.stringify(oneLine(workbook.getSheet(selection.sheet).name, 40))}.`;
}

interface ProposeRequest {
  task: string;
  rules: string[];
  request: string;
  sheet: SheetId;
  focus: CellRange | null;
  scope: EditScope;
  label: string;
}

/** Asks for edits, validates them and records them. Nothing is applied unless every edit is valid. */
export async function proposeWithModel(ctx: AgentContext, req: ProposeRequest): Promise<ProposalOutcome> {
  const workbook = ctx.session.workbook;
  const parts: Omit<PromptParts, "blocks"> = { task: req.task, rules: req.rules, format: agentEditInstructions("sheet"), request: req.request };
  const prompt = buildPrompt({ ...parts, blocks: sheetBlocks(workbook, req.sheet, parts, req.focus) });
  const reply = await askModel(ctx.ai, prompt, { signal: ctx.signal, log: ctx.log });
  // The workbook may have changed while the model was thinking: validate against it as it is now.
  const checked = validateReply(ctx.session.workbook, reply, req.scope);
  if (!checked.ok) {
    if (checked.reason === "empty") return { status: "no_changes", summary: checked.messages[0] ?? "" };
    return { status: "invalid", messages: checked.messages };
  }
  const record = runProposal(ctx.session, req.label, isoNow(ctx), (wb) => {
    for (const edit of checked.edits) writeResolved(wb, edit);
  }, ctx.log);
  if (record.changeIds.length === 0) return { status: "no_changes", summary: checked.summary || "The proposed values are already in place." };
  return { status: "proposed", ...record, label: req.label, summary: checked.summary };
}

/** Edits the workbook as the owner asks. Every change lands in a proposal for review. */
export async function editByInstruction(ctx: AgentContext, instruction: string, selection: SheetSelection): Promise<ProposalOutcome> {
  const request = cleanRequest(instruction);
  return proposeWithModel(ctx, {
    task: "Change the spreadsheet as the owner asks, using as few cell edits as needed. Prefer formulas that refer to existing cells over typed-in numbers.",
    rules: [selectionLine(ctx.session.workbook, selection), "Use only sheets and cells shown below. Quote what you saw in \"expect\" when you change a cell that has content."].filter((rule) => rule !== ""),
    request,
    sheet: selection.sheet,
    focus: null,
    scope: {},
    label: `Assistant: ${oneLine(request, 80)}`,
  });
}

/** True when the selection holds something: a table to extend rather than a place to start one. */
function hasContent(workbook: Workbook, selection: SheetSelection): boolean {
  const { start, end } = selection.range;
  if ((end.row - start.row + 1) * (end.col - start.col + 1) > 10_000) return true;
  for (let row = start.row; row <= end.row; row++) {
    for (let col = start.col; col <= end.col; col++) {
      const cell = workbook.getCell(selection.sheet, { row, col });
      if (cell.value !== null || cell.formula !== null) return true;
    }
  }
  return false;
}

/**
 * Builds a new table from an instruction, or extends the table in the
 * selection. A new table may only fill empty cells; extending may change the
 * selected table and fill empty cells around it.
 */
export async function buildTable(ctx: AgentContext, instruction: string, selection: SheetSelection): Promise<ProposalOutcome> {
  const workbook = ctx.session.workbook;
  const request = cleanRequest(instruction);
  const extend = hasContent(workbook, selection);
  const name = JSON.stringify(oneLine(workbook.getSheet(selection.sheet).name, 40));
  const where = extend
    ? `Extend the table in ${formatA1Range(selection.range)} on the sheet ${name}: add the rows or columns the owner asks for next to it, keeping its header and layout.`
    : `Write the new table on the sheet ${name} with its top-left cell at ${formatA1(selection.range.start)}: a header row first, then one row per record.`;
  return proposeWithModel(ctx, {
    task: `Build a table as the owner asks. ${where}`,
    rules: [
      "Use setRange for the table body. Write totals and derived columns as formulas.",
      extend ? "Do not change cells outside the table except empty cells next to it." : "Write only into empty cells.",
    ],
    request,
    sheet: selection.sheet,
    focus: null,
    scope: { sheet: selection.sheet, editable: extend ? selection.range : null },
    label: `Assistant: ${extend ? "extend table" : "build table"}`,
  });
}
