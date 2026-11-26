import { describe, expect, it } from "vitest";
import { GridContext } from "../../../../home/apps/sheets/src/grid/context";
import { createAxis } from "../../../../home/apps/sheets/src/grid/geometry";
import { type PaneSpec, buildPane } from "../../../../home/apps/sheets/src/grid/render-model";
import { selectCell } from "../../../../home/apps/sheets/src/grid/selection";
import { createSheetSession } from "../../../../home/apps/sheets/src/session";
import { harness } from "../session/fakes";

/** `count` indexes from `first` with no size, as a file's hidden rows or columns have. */
function hidden(first: number, count: number): Array<[number, number]> {
  return Array.from({ length: count }, (_, k) => [first + k, 0] as [number, number]);
}

describe("buildPane", () => {
  it("lists a merged cell from the rows and columns on screen, not from every address it spans", () => {
    const session = createSheetSession(harness().deps);
    const sheet = session.getState().activeSheetId;
    // A merge across 100 000 hidden rows and 2 000 hidden columns: about 200 million addresses, a few hundred on screen.
    const merge = { start: { row: 0, col: 0 }, end: { row: 100_010, col: 2_010 } };
    expect(session.setCellInput(sheet, merge.start, "title").ok).toBe(true);
    expect(session.mergeCells(sheet, merge).ok).toBe(true);
    expect(session.setCellInput(sheet, { row: 100_020, col: 2_003 }, "below").ok).toBe(true);
    const ctx = new GridContext(session);
    const base = ctx.layout();
    const axes = { rows: createAxis(100_100, 20, hidden(1, 100_000)), cols: createAxis(2_100, 72, hidden(1, 2_000)) };
    const pane: PaneSpec = { id: "main", rows: { start: 0, end: 100_030 }, cols: { start: 0, end: 2_020 }, x: 0, y: 0, width: 1_000, height: 800, offsetX: 0, offsetY: 0 };

    const model = buildPane(ctx, { ...base, axes }, pane, { gridId: "g", selection: selectCell({ row: 0, col: 0 }, [merge]), editing: null });

    const cells = model.rows.flatMap((row) => row.cells);
    const title = cells.find((cell) => cell.row === 0 && cell.col === 0);
    expect(title).toMatchObject({ text: "title", className: expect.stringContaining("is-merged") });
    // The shown cells the merge covers are drawn by it, not on their own.
    expect(cells.filter((cell) => cell.row <= merge.end.row && cell.col <= merge.end.col)).toEqual([title]);
    expect(cells.find((cell) => cell.row === 100_020 && cell.col === 2_003)?.text).toBe("below");
    expect(model.horizontal.length).toBeLessThan(40);
    expect(model.vertical.length).toBeLessThan(30);
  });
});
