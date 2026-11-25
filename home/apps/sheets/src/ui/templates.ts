/**
 * Starting points on the start screen. Each one is built with the engine's
 * workbook API (inputs, formulas, styles, widths, frozen panes), so it
 * calculates, saves and reopens like any other workbook.
 */
import { createXlsx, type CellStylePatch, type SheetId, type Workbook } from "../session/engine";

export type SheetsTemplateId = "blank" | "budget" | "task-tracker";

export interface SheetsTemplateInfo {
  id: SheetsTemplateId;
  label: string;
  description: string;
  /** Name of the new workbook. */
  name: string;
}

export const SHEETS_TEMPLATES: readonly SheetsTemplateInfo[] = [
  { id: "blank", label: "Blank workbook", description: "An empty sheet", name: "Untitled.xlsx" },
  { id: "budget", label: "Budget", description: "Planned against actual, with totals", name: "Budget.xlsx" },
  { id: "task-tracker", label: "Task tracker", description: "Tasks, owners, status and due dates", name: "Task tracker.xlsx" },
];

export function sheetsTemplate(id: string): SheetsTemplateInfo | null {
  return SHEETS_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** Workbook files keep their own colours; these are the Sheets accent and its wash. */
const HEADER_FILL = "#E3F2E8";
const HEADER_INK = "#1F4F33";
const LINE = "#9FB8A8";

const HEADER: CellStylePatch = {
  font: { bold: true, color: HEADER_INK },
  fill: { color: HEADER_FILL },
  border: { bottom: { style: "thin", color: LINE } },
};

function fill(workbook: Workbook, sheet: SheetId, rows: ReadonlyArray<ReadonlyArray<string>>, startRow = 0): void {
  rows.forEach((row, r) => row.forEach((input, c) => input !== "" && workbook.setCellInput(sheet, { row: startRow + r, col: c }, input)));
}

function range(r1: number, c1: number, r2: number, c2: number) {
  return { start: { row: r1, col: c1 }, end: { row: r2, col: c2 } };
}

const BUDGET_LINES: ReadonlyArray<readonly [string, string]> = [
  ["Housing", "1500"],
  ["Utilities", "220"],
  ["Groceries", "480"],
  ["Transport", "160"],
  ["Health", "90"],
  ["Savings", "400"],
  ["Other", "150"],
];

function budget(): Workbook {
  const workbook = createXlsx({ sheetNames: ["Budget"] });
  const sheet = workbook.listSheets()[0].id;
  const first = 3;
  const last = first + BUDGET_LINES.length - 1;
  const total = last + 1;
  workbook.setCellInput(sheet, { row: 0, col: 0 }, "Monthly budget");
  workbook.setStyle(sheet, range(0, 0, 0, 0), { font: { bold: true, sizePt: 14, color: HEADER_INK } });
  fill(workbook, sheet, [["Category", "Planned", "Actual", "Difference"]], 2);
  BUDGET_LINES.forEach(([category, planned], index) => {
    const row = first + index;
    const excel = row + 1;
    fill(workbook, sheet, [[category, planned, "", `=B${excel}-C${excel}`]], row);
  });
  fill(workbook, sheet, [["Total", `=SUM(B${first + 1}:B${last + 1})`, `=SUM(C${first + 1}:C${last + 1})`, `=SUM(D${first + 1}:D${last + 1})`]], total);
  workbook.setStyle(sheet, range(2, 0, 2, 3), HEADER);
  workbook.setStyle(sheet, range(2, 1, 2, 3), { alignment: { horizontal: "right" } });
  workbook.setStyle(sheet, range(first, 1, total, 3), { numberFormat: "#,##0.00" });
  workbook.setStyle(sheet, range(total, 0, total, 3), { font: { bold: true }, border: { top: { style: "thin", color: LINE } } });
  workbook.setColumnWidth(sheet, 0, 24);
  for (const col of [1, 2, 3]) workbook.setColumnWidth(sheet, col, 14);
  workbook.setFrozenPanes(sheet, { rows: 3, cols: 0 });
  return workbook;
}

const STATUSES = ["Not started", "In progress", "Done"] as const;

function taskTracker(): Workbook {
  const workbook = createXlsx({ sheetNames: ["Tasks"] });
  const sheet = workbook.listSheets()[0].id;
  fill(workbook, sheet, [
    ["Task", "Owner", "Status", "Due", "Notes", "", "Status", "Tasks"],
    ["Write the project brief", "", STATUSES[2], "2026-12-01", "", "", STATUSES[0], "=COUNTIF($C$2:$C$500,G2)"],
    ["Review the brief with the team", "", STATUSES[1], "2026-12-03", "", "", STATUSES[1], "=COUNTIF($C$2:$C$500,G3)"],
    ["Plan the next steps", "", STATUSES[0], "2026-12-08", "", "", STATUSES[2], "=COUNTIF($C$2:$C$500,G4)"],
  ]);
  workbook.setStyle(sheet, range(0, 0, 0, 4), HEADER);
  workbook.setStyle(sheet, range(0, 6, 0, 7), HEADER);
  workbook.setStyle(sheet, range(1, 3, 199, 3), { numberFormat: "yyyy-mm-dd" });
  const widths = [34, 16, 14, 12, 36, 4, 14, 8];
  widths.forEach((width, col) => workbook.setColumnWidth(sheet, col, width));
  workbook.setFrozenPanes(sheet, { rows: 1, cols: 0 });
  return workbook;
}

/** The starting workbook of a template, calculated; null for the blank workbook. */
export function buildTemplate(id: SheetsTemplateId): Workbook | null {
  const workbook = id === "budget" ? budget() : id === "task-tracker" ? taskTracker() : null;
  workbook?.recalc();
  return workbook;
}
