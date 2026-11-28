import { readFileSync } from "node:fs";
import path from "node:path";
import type { CellAddress, CellRange, SheetId } from "../../../../home/apps/_shared/office-engine/index";
import type { CellDecoration } from "../../../../home/apps/sheets/src/grid";
import { type SheetSession, openSheetSession } from "../../../../home/apps/sheets/src/session";
import { harness } from "../session/fakes";

export const MODEL_PATH = "Documents/model.xlsx";

export function modelBytes(): Uint8Array {
  return new Uint8Array(readFileSync(path.resolve(__dirname, "../../../office/fixtures/model.xlsx")));
}

export interface ModelSession {
  session: SheetSession;
  sheets: { assumptions: SheetId; projection: SheetId; summary: SheetId };
}

/** The financial model from the engine fixtures, opened in a real session with autosave off. */
export async function openModel(): Promise<ModelSession> {
  const h = harness();
  h.files.put(MODEL_PATH, modelBytes());
  const session = await openSheetSession({ ...h.deps, autosaveDelayMs: 60_000 }, MODEL_PATH);
  session.setAutosave(false);
  const id = (name: string): SheetId => {
    const sheet = session.workbook.getSheetByName(name);
    if (sheet === null) throw new Error(`no sheet ${name}`);
    return sheet.id;
  };
  return { session, sheets: { assumptions: id("Assumptions"), projection: id("Projection"), summary: id("Summary") } };
}

/** A grid stand-in that records what review and the assistant ask of it. */
export class FakeGrid {
  readonly layers = new Map<string, CellDecoration[]>();
  readonly selected: Array<{ target: CellAddress | CellRange; sheet?: SheetId }> = [];
  readonly scrolled: Array<{ cell: CellAddress; sheet?: SheetId }> = [];

  select(target: CellAddress | CellRange, sheet?: SheetId): void {
    this.selected.push({ target, sheet });
  }

  scrollTo(cell: CellAddress, sheet?: SheetId): void {
    this.scrolled.push({ cell, sheet });
  }

  decorate(layer: string, decorations: readonly CellDecoration[]): void {
    if (decorations.length === 0) this.layers.delete(layer);
    else this.layers.set(layer, [...decorations]);
  }

  clearDecorations(layer?: string): void {
    if (layer === undefined) this.layers.clear();
    else this.layers.delete(layer);
  }
}

export const DATE = "2026-11-20T10:00:00.000Z";

/** Two proposals on the model: the assistant links the total and raises growth; a colleague raises costs. */
export function proposeOnModel(model: ModelSession): void {
  const { assumptions, summary } = model.sheets;
  model.session.mutate((workbook) => {
    workbook.beginProposal({ author: "Matrix Assistant", date: DATE, label: "Link the total revenue" });
    workbook.setFormula(summary, { row: 1, col: 1 }, "Projection!N4");
    workbook.setCell(assumptions, { row: 2, col: 1 }, 0.05);
    workbook.endProposal();
    workbook.beginProposal({ author: "Alex", date: DATE, label: "Higher costs" });
    workbook.setCell(assumptions, { row: 4, col: 1 }, 20000);
    workbook.endProposal();
  });
}
