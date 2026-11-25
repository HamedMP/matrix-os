// @vitest-environment jsdom
/**
 * Back to the start screen from an open workbook, through the title bar and
 * through File > Close: edits that cannot be saved by themselves ask Save,
 * Discard or Cancel first, and a failed save keeps the workbook open.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { flush, renderApp, renderWithWorkbook } from "./harness";

afterEach(cleanup);

function goHome(): void {
  fireEvent.click(screen.getByRole("button", { name: "Back to Sheets home" }));
}

function fileClose(): void {
  fireEvent.click(screen.getByRole("tab", { name: "File" }));
  const backstage = screen.getByRole("dialog", { name: /File/ });
  fireEvent.click(within(backstage).getByRole("button", { name: "Close" }));
}

function type(app: Awaited<ReturnType<typeof renderApp>>, text: string): void {
  act(() => {
    app.session().setCellInput(app.session().getState().activeSheetId, { row: 0, col: 0 }, text);
  });
}

async function startScreen(): Promise<void> {
  await flush();
  expect(screen.getByRole("button", { name: /^Blank workbook/ })).toBeTruthy();
}

describe("Back to the Sheets start screen", () => {
  it("saves a Matrix workbook by itself and lists it on the start screen", async () => {
    const app = await renderWithWorkbook("Reports/Budget.xlsx");
    type(app, "42");
    goHome();
    await startScreen();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(app.host.session).toBeNull();
    expect(screen.getByRole("button", { name: /^Budget\.xlsx, in / })).toBeTruthy();
    const saved = await openXlsx(app.bridge.fileStore.bytes("Reports/Budget.xlsx"));
    expect(saved.getCell(saved.listSheets()[0]!.id, { row: 0, col: 0 }).value).toBe(42);
  });

  it("asks Save, Discard or Cancel for a new workbook, and Save asks where before going home", async () => {
    const app = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /^Blank workbook/ }));
    await flush();
    type(app, "draft");

    goHome();
    await flush();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Save changes to Untitled.xlsx?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Untitled.xlsx" })).toBeTruthy();

    goHome();
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    await flush();
    const saveAs = screen.getByRole("dialog", { name: "Save workbook" });
    fireEvent.change(within(saveAs).getByLabelText("File name"), { target: { value: "Plan" } });
    fireEvent.click(within(saveAs).getByRole("button", { name: "Save" }));
    await flush();
    await startScreen();
    expect(app.bridge.fileStore.store.has("Documents/Plan.xlsx")).toBe(true);
    expect(screen.getByRole("button", { name: /^Plan\.xlsx, in / })).toBeTruthy();
  });

  it("keeps the workbook open and shows why when the save fails, and goes home on Discard", async () => {
    const app = await renderWithWorkbook();
    type(app, "7");
    app.bridge.fileStore.failNext = "forbidden";
    goHome();
    await flush();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("could not be written");

    app.bridge.fileStore.failNext = "forbidden";
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Budget.xlsx" })).toBeTruthy();
    expect(document.querySelector(".oui-toast--danger .oui-toast__title")?.textContent).toBe("Sheets may not open or change this file.");
    expect(app.host.session).not.toBeNull();

    app.bridge.fileStore.failNext = "forbidden";
    goHome();
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await startScreen();
    expect(app.host.session).toBeNull();
  });

  it("does the same through File > Close", async () => {
    const app = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /^Blank workbook/ }));
    await flush();
    type(app, "draft");
    fileClose();
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await startScreen();

    fireEvent.click(screen.getByRole("button", { name: /^Blank workbook/ }));
    await flush();
    fileClose();
    await startScreen();
  });

  describe("with text in the cell editor that cannot be stored", () => {
    function typeBadFormula(app: Awaited<ReturnType<typeof renderApp>>): void {
      const grid = app.container.querySelector<HTMLElement>("[role='grid']")!;
      act(() => grid.focus());
      fireEvent.keyDown(grid, { key: "=" });
      const input = app.container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea")!;
      fireEvent.change(input, { target: { value: "=1+" } });
    }

    function editorText(app: Awaited<ReturnType<typeof renderApp>>): string | null {
      return app.container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea")?.value ?? null;
    }

    it("stays on the workbook with the editor open instead of going home", async () => {
      const app = await renderWithWorkbook();
      typeBadFormula(app);
      goHome();
      await flush();
      expect(app.host.session).not.toBeNull();
      expect(editorText(app)).toBe("=1+");

      fileClose();
      await flush();
      expect(app.host.session).not.toBeNull();
      expect(editorText(app)).toBe("=1+");
    });

    it("does not save until the text is fixed", async () => {
      const app = await renderWithWorkbook();
      act(() => {
        app.session().setCellInput(app.session().getState().activeSheetId, { row: 5, col: 5 }, "7");
      });
      typeBadFormula(app);
      fireEvent.keyDown(window, { key: "s", ctrlKey: true });
      await flush();
      expect(app.bridge.fileStore.writes).toEqual([]);
      expect(editorText(app)).toBe("=1+");
    });
  });
});
