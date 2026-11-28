// @vitest-environment jsdom
/**
 * A fill reads its source cells before it writes the target. A huge source
 * dragged one row on is refused before any of it is read, so an almost empty
 * workbook cannot freeze the window on a fill.
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workbook } from "../../../../home/apps/_shared/office-engine/index";
import { beginFillDrag, dragFillTo, endFillDrag } from "../../../../home/apps/sheets/src/grid/actions-data";
import { renderGrid } from "./harness";

afterEach(cleanup);

describe("a fill from a source too large for one step", () => {
  // Fault: only the target was bounded, so a 1,000,000-cell source dragged one row read every source cell first.
  it("is refused before the source is read, and nothing changes", async () => {
    const h = await renderGrid((workbook: Workbook, sheet: string) => {
      workbook.setCell(sheet, { row: 0, col: 0 }, "kept");
    });
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 1999, col: 499 } }));
    const reads = vi.spyOn(h.session, "raw");
    const ctx = h.controller.context;
    act(() => {
      beginFillDrag(ctx);
      dragFillTo(ctx, { row: 2000, col: 0 });
      endFillDrag(ctx);
    });
    expect(reads.mock.calls.length).toBeLessThan(1_000);
    expect(h.session.raw(h.sheet, 2000, 0).value).toBeNull();
    expect(h.container.querySelector("[role='alert']")?.textContent).toContain("That is too many cells for one step.");
    h.unmount();
  });

  it("still fills from a source that fits", async () => {
    const h = await renderGrid();
    act(() => h.controller.select({ start: { row: 0, col: 0 }, end: { row: 2, col: 0 } }));
    const ctx = h.controller.context;
    act(() => {
      beginFillDrag(ctx);
      dragFillTo(ctx, { row: 4, col: 0 });
      endFillDrag(ctx);
    });
    expect([h.session.raw(h.sheet, 3, 0).value, h.session.raw(h.sheet, 4, 0).value]).toEqual([4, 5]);
    h.unmount();
  });
});
