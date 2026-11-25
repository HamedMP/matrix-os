// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { DEFAULT_AUTOSAVE_DELAY_MS } from "../../../../home/apps/sheets/src/session/save";
import { flush, renderWithWorkbook } from "./harness";

afterEach(cleanup);

async function a1(bytes: Uint8Array): Promise<unknown> {
  const workbook = await openXlsx(bytes);
  return workbook.getCell(workbook.listSheets()[0]!.id, { row: 0, col: 0 }).value;
}

describe("Sheets saves before its window goes away", () => {
  for (const leave of ["blur", "pagehide"] as const) {
    it(`commits the text in the cell editor and saves on ${leave}`, async () => {
      const app = await renderWithWorkbook();
      const grid = app.container.querySelector<HTMLElement>("[role='grid']")!;
      act(() => grid.focus());
      fireEvent.keyDown(grid, { key: "9" });
      expect(app.container.querySelector("textarea.sg-input__field")).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new Event(leave));
      });
      await flush();
      expect(app.session().cell(app.session().getState().activeSheetId, 0, 0).value).toBe(9);
      expect(await a1(app.bridge.fileStore.bytes("Budget.xlsx"))).toBe(9);
    });
  }

  it("autosaves after a short pause", () => {
    expect(DEFAULT_AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(1000);
  });
});
