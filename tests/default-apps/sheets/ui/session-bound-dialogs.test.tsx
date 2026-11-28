// @vitest-environment jsdom
/**
 * Save as, Save a copy and the unsaved-edits question belong to the workbook
 * they were opened for. When Files opens another workbook while one of them
 * is up, it goes away: its buttons never save or discard the new workbook.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { flush, renderApp, renderWithWorkbook, workbookBytes } from "./harness";

afterEach(cleanup);

function openBackstageItem(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name: "File" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: /File/ })).getByRole("button", { name }));
}

describe("dialogs bound to one workbook", () => {
  it("drops Save a copy when Files opens another workbook, so it never saves that one", async () => {
    const app = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /^Blank workbook/ }));
    await flush();
    openBackstageItem("Save a copy to Matrix");
    await flush();
    expect(screen.getByRole("dialog", { name: "Save a copy to Matrix" })).toBeTruthy();

    app.bridge.fileStore.put("Other.xlsx", await workbookBytes());
    act(() => app.bridge.requestOpen("Other.xlsx"));
    await flush();
    expect(screen.getByRole("heading", { name: "Other.xlsx" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Save a copy to Matrix" })).toBeNull();
    expect(app.bridge.fileStore.writes).toEqual([]);
  });

  it("drops the unsaved-edits question when another workbook opened, so Discard never closes that one", async () => {
    const app = await renderWithWorkbook("Budget.xlsx");
    act(() => {
      app.session().setCellInput(app.session().getState().activeSheetId, { row: 0, col: 0 }, "7");
    });
    app.bridge.fileStore.failNext = "forbidden";
    fireEvent.click(screen.getByRole("button", { name: "Back to Sheets home" }));
    await flush();
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // The next save works: Files opens another workbook, saving Budget first.
    app.bridge.fileStore.put("Other.xlsx", await workbookBytes());
    act(() => app.bridge.requestOpen("Other.xlsx"));
    await flush();
    expect(screen.getByRole("heading", { name: "Other.xlsx" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(app.session().getState().path).toBe("Other.xlsx");
  });
});
