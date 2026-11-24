import { describe, expect, it } from "vitest";
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
});
