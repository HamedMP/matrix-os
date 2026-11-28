import { describe, expect, it } from "vitest";
import { createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { MARKUP_LAYER, SheetReviewController } from "../../../../home/apps/sheets/src/review";
import { FakeGrid, openModel, proposeOnModel } from "./fixture";

const N4 = { row: 3, col: 13 };
const B2 = { row: 1, col: 1 };

describe("SheetReviewController", () => {
  it("steps through changes and brings each cell into view", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const grid = new FakeGrid();
    const review = new SheetReviewController(model.session, grid);
    expect(review.getState()).toMatchObject({ total: 3, index: -1, currentId: null });

    review.next();
    expect(review.getState().index).toBe(0);
    expect(grid.selected.at(-1)).toEqual({ target: { row: 2, col: 1 }, sheet: model.sheets.assumptions });
    review.next();
    review.next();
    expect(review.getState().current?.location).toBe("Assumptions!B5");
    review.next();
    // Wraps around to the first change.
    expect(review.getState().index).toBe(0);
    review.previous();
    expect(review.getState().index).toBe(2);
    review.goTo(review.getState().items[1]!.id);
    expect(grid.selected.at(-1)).toEqual({ target: B2, sheet: model.sheets.summary });
    review.dispose();
  });

  it("rejects one change, restores the old value and recalculates the dependants", async () => {
    const model = await openModel();
    const { session, sheets } = model;
    const before = session.cell(sheets.projection, N4.row, N4.col).value as number;
    proposeOnModel(model);
    expect(session.cell(sheets.projection, N4.row, N4.col).value as number).toBeGreaterThan(before);

    const review = new SheetReviewController(session, new FakeGrid());
    const growth = review.getState().items[0]!;
    review.goTo(growth.id);
    expect(review.rejectCurrent().ok).toBe(true);
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.03);
    expect(session.cell(sheets.projection, N4.row, N4.col).value).toBeCloseTo(before, 6);
    // The linked total follows the restored projection.
    expect(session.cell(sheets.summary, B2.row, B2.col).value).toBeCloseTo(before, 6);
    expect(review.getState().total).toBe(2);
    // The position stays where the rejected change was, on the next one.
    expect(review.getState().current?.location).toBe("Summary!B2");
    review.dispose();
  });

  it("accepts a selection and rejects the rest", async () => {
    const model = await openModel();
    const { session, sheets } = model;
    proposeOnModel(model);
    const review = new SheetReviewController(session, new FakeGrid());
    const [growth, total, costs] = review.getState().items;
    review.toggleSelected(total!.id);
    review.toggleSelected(costs!.id);
    expect(review.getState().selectedIds).toEqual([total!.id, costs!.id]);

    expect(review.accept("selection").ok).toBe(true);
    expect(session.cell(sheets.summary, B2.row, B2.col).formula).toBe("Projection!N4");
    expect(session.cell(sheets.assumptions, 4, 1).value).toBe(20000);
    expect(review.getState().selectedIds).toEqual([]);
    expect(review.getState().items.map((item) => item.id)).toEqual([growth!.id]);

    expect(review.reject("all").ok).toBe(true);
    expect(review.getState().total).toBe(0);
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.03);
    expect(session.workbook.listChanges()).toEqual([]);
    review.dispose();
  });

  it("accepts all changes of one proposal", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const review = new SheetReviewController(model.session, new FakeGrid());
    const group = review.getState().groups[0]!;
    expect(review.accept(group.items.map((item) => item.id)).ok).toBe(true);
    expect(review.getState().groups.map((entry) => entry.label)).toEqual(["Higher costs"]);
    review.dispose();
  });

  it("decorates changed cells when markup is on and removes them when off", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const grid = new FakeGrid();
    const review = new SheetReviewController(model.session, grid);
    expect(grid.layers.has(MARKUP_LAYER)).toBe(false);
    review.setMarkup(true);
    expect(grid.layers.get(MARKUP_LAYER)?.map((decoration) => decoration.oldValue)).toEqual(["3.0%", "725,000", "18000"]);
    review.reject("all");
    expect(grid.layers.has(MARKUP_LAYER)).toBe(false);
    proposeOnModel(model);
    expect(grid.layers.get(MARKUP_LAYER)).toHaveLength(3);
    review.toggleMarkup();
    expect(review.getState().markup).toBe(false);
    expect(grid.layers.has(MARKUP_LAYER)).toBe(false);
    review.dispose();
  });

  it("follows changes made elsewhere and notifies listeners", async () => {
    const model = await openModel();
    const review = new SheetReviewController(model.session, null);
    let calls = 0;
    const stop = review.subscribe(() => {
      calls += 1;
    });
    proposeOnModel(model);
    expect(calls).toBeGreaterThan(0);
    expect(review.getState().total).toBe(3);
    stop();
    review.dispose();
  });

  it("reports an unknown change id with a safe message and changes nothing", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const review = new SheetReviewController(model.session, null);
    const result = review.accept(["no-such-change"]);
    expect(result.ok).toBe(false);
    expect(review.getState().notice).toMatch(/no longer/i);
    expect(review.getState().total).toBe(3);
    review.dispose();
  });
  it("stores the text in the cell editor before it resolves changes, and resolves none while the editor refuses it", async () => {
    const model = await openModel();
    const { session, sheets } = model;
    proposeOnModel(model);
    const grid = createSheetGridController(session);
    const review = new SheetReviewController(session, grid);
    session.setActiveSheet(sheets.assumptions);
    grid.select({ row: 2, col: 1 });
    grid.startEdit("=1+*");
    expect(review.accept("all")).toMatchObject({ ok: false });
    expect(review.getState().total).toBe(3);
    expect(grid.isEditing).toBe(true);

    // The owner types over a proposed cell: the typed value goes in, then the change is resolved over it.
    grid.cancelEdit();
    grid.startEdit("0.07");
    expect(review.reject("all").ok).toBe(true);
    expect(grid.isEditing).toBe(false);
    const resolved = session.cell(sheets.assumptions, 2, 1).value;
    // Nothing is left in the editor to write over the resolved cell.
    expect(grid.commitEdit()).toBe(true);
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(resolved);
    review.dispose();
    grid.dispose();
  });

  // Outcome: Accept or Reject acts on the change the owner was looking at. Fault: storing the typed
  // text resolves the current change and moves on, and the next change is resolved instead.
  it.each([
    ["rejects", (review: SheetReviewController) => review.rejectCurrent()],
    ["accepts", (review: SheetReviewController) => review.acceptCurrent()],
  ])("%s the current change, not the next one, when the owner typed over its cell", async (_name, act) => {
    const model = await openModel();
    const { session, sheets } = model;
    proposeOnModel(model);
    const grid = createSheetGridController(session);
    const review = new SheetReviewController(session, grid);
    const [growth, total, costs] = review.getState().items;
    review.goTo(growth!.id);
    grid.startEdit("0.07");
    expect(act(review).ok).toBe(true);
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.07);
    expect(review.getState().items.map((item) => item.id)).toEqual([total!.id, costs!.id]);
    expect(session.cell(sheets.summary, B2.row, B2.col).formula).toBe("Projection!N4");
    review.dispose();
    grid.dispose();
  });

  it("resolves the selected changes that were pending when the owner clicked, skipping one the typed text resolved", async () => {
    const model = await openModel();
    const { session, sheets } = model;
    proposeOnModel(model);
    const grid = createSheetGridController(session);
    const review = new SheetReviewController(session, grid);
    const [growth, total, costs] = review.getState().items;
    review.setSelected([growth!.id, costs!.id]);
    session.setActiveSheet(sheets.assumptions);
    grid.select({ row: 2, col: 1 });
    grid.startEdit("0.07");
    expect(review.reject("selection")).toEqual({ ok: true, resolved: 1 });
    expect(session.cell(sheets.assumptions, 2, 1).value).toBe(0.07);
    expect(session.cell(sheets.assumptions, 4, 1).value).not.toBe(20000);
    expect(review.getState().items.map((item) => item.id)).toEqual([total!.id]);
    review.dispose();
    grid.dispose();
  });
});
