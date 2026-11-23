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
  expect(screen.getByRole("button", { name: /^New blank workbook/ })).toBeTruthy();
}

describe("Back to the Sheets start screen", () => {
  it("saves a Matrix workbook by itself and lists it on the start screen", async () => {
    const app = await renderWithWorkbook("Reports/Budget.xlsx");
    type(app, "42");
    goHome();
    await startScreen();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(app.host.session).toBeNull();
    expect(screen.getByRole("button", { name: /Budget\.xlsx/ })).toBeTruthy();
    const saved = await openXlsx(app.bridge.fileStore.bytes("Reports/Budget.xlsx"));
    expect(saved.getCell(saved.listSheets()[0]!.id, { row: 0, col: 0 }).value).toBe(42);
  });

  it("asks Save, Discard or Cancel for a new workbook, and Save asks where before going home", async () => {
    const app = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /New blank workbook/ }));
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
    expect(screen.getByRole("button", { name: /Plan\.xlsx/ })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: /New blank workbook/ }));
    await flush();
    type(app, "draft");
    fileClose();
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await startScreen();

    fireEvent.click(screen.getByRole("button", { name: /New blank workbook/ }));
    await flush();
    fileClose();
    await startScreen();
  });
});
