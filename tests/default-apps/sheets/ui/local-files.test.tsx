// @vitest-environment jsdom
/**
 * Opening a workbook from this computer (chooser and drag and drop), saving
 * it back as a download, saving a copy to Matrix, and downloading a copy of
 * a Matrix workbook. Only the browser's file input and downloads are used,
 * so Web Desktop and Electron Desktop behave the same.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { flush, renderApp, renderWithWorkbook, workbookBytes } from "./harness";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Makes the next file chooser pick `file`. */
function chooseOnComputer(file: File): void {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    if (this.type !== "file") return;
    Object.defineProperty(this, "files", { configurable: true, value: [file] });
    this.dispatchEvent(new Event("change"));
  });
}

async function openLocal(name = "Budget.xlsx") {
  const app = await renderApp();
  chooseOnComputer(new File([(await workbookBytes()) as BlobPart], name));
  fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
  await flush();
  await flush();
  return app;
}

function edit(app: Awaited<ReturnType<typeof renderApp>>, text: string): void {
  act(() => {
    app.session().setCellInput(app.session().getState().activeSheetId, { row: 0, col: 0 }, text);
  });
}

async function a1(bytes: Uint8Array): Promise<unknown> {
  const workbook = await openXlsx(bytes);
  return workbook.getCell(workbook.listSheets()[0]!.id, { row: 0, col: 0 }).value;
}

function openBackstageItem(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name: "File" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: /File/ })).getByRole("button", { name }));
}

describe("a workbook from this computer", () => {
  it("opens from the start screen as a local document with a badge and no recent entry", async () => {
    const app = await openLocal();
    expect(screen.getByRole("heading", { name: "Budget.xlsx" })).toBeTruthy();
    expect(screen.getByText("From this computer")).toBeTruthy();
    expect(app.session().getState()).toMatchObject({ source: "local", path: null, autosave: false });
    expect(app.bridge.db.rows).toEqual([]);
  });

  it("saves by downloading the updated file under the same name", async () => {
    const app = await openLocal();
    edit(app, "40");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await flush();
    expect(app.downloads.map((file) => [file.name, file.mimeType])).toEqual([["Budget.xlsx", XLSX_MIME]]);
    expect(await a1(app.downloads[0]!.bytes)).toBe(40);
    expect(app.session().getState().dirty).toBe(false);
    expect(screen.getByText("Downloaded")).toBeTruthy();
    expect(app.bridge.fileStore.writes).toEqual([]);
  });

  it("becomes a Matrix document after Save a copy to Matrix, and then appears in the recent list", async () => {
    const app = await openLocal();
    edit(app, "41");
    openBackstageItem("Save a copy to Matrix");
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Save a copy to Matrix" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(await a1(app.bridge.fileStore.bytes("Documents/Budget.xlsx"))).toBe(41);
    expect(app.session().getState()).toMatchObject({ source: "matrix", path: "Documents/Budget.xlsx", autosave: true });
    expect(screen.queryByText("From this computer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to Sheets home" }));
    await flush();
    expect(screen.getByRole("button", { name: /^Budget\.xlsx, in / })).toBeTruthy();
  });

  it("asks before leaving unsaved edits, and Save downloads them and goes home without a recent entry", async () => {
    const app = await openLocal();
    edit(app, "9");
    fireEvent.click(screen.getByRole("button", { name: "Back to Sheets home" }));
    await flush();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("came from this computer");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    expect(app.downloads).toHaveLength(1);
    expect(await a1(app.downloads[0]!.bytes)).toBe(9);
    expect(app.host.session).toBeNull();
    expect(screen.getByText("No recent workbooks")).toBeTruthy();
  });

  it("opens a spreadsheet dropped on the window and refuses other files", async () => {
    const app = await renderApp();
    const target = screen.getByRole("button", { name: /^Blank workbook/ });
    const transfer = (files: File[]) => ({ types: ["Files"], files, dropEffect: "none" });
    fireEvent.dragEnter(target, { dataTransfer: transfer([]) });
    fireEvent.drop(target, { dataTransfer: transfer([new File(["x"], "photo.png")]) });
    await flush();
    expect(document.querySelector(".oui-toast--danger .oui-toast__title")?.textContent).toContain("photo.png");

    fireEvent.dragEnter(target, { dataTransfer: transfer([]) });
    fireEvent.drop(target, { dataTransfer: transfer([new File(["name,amount\nTea,3\n"], "costs.csv")]) });
    await flush();
    await flush();
    expect(screen.getByRole("heading", { name: "costs.csv" })).toBeTruthy();
    expect(app.session().getState()).toMatchObject({ source: "local", format: "csv" });
  });

  it("says why a file that is not a spreadsheet does not open", async () => {
    await renderApp();
    chooseOnComputer(new File(["not a zip"], "broken.xlsx"));
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    await flush();
    await flush();
    expect(document.querySelector(".oui-toast--danger .oui-toast__title")?.textContent).toBe("broken.xlsx could not be opened");
    expect(screen.getByRole("button", { name: /^Blank workbook/ })).toBeTruthy();
  });
});

describe("a Matrix workbook", () => {
  it("downloads a copy as .xlsx and as CSV without changing the file", async () => {
    const app = await renderWithWorkbook("Reports/Budget.xlsx");
    openBackstageItem("Download a copy (.xlsx)");
    await flush();
    openBackstageItem("Download as CSV");
    await flush();
    expect(app.downloads.map((file) => [file.name, file.mimeType])).toEqual([
      ["Budget.xlsx", XLSX_MIME],
      ["Budget.csv", "text/csv"],
    ]);
    expect(await a1(app.downloads[0]!.bytes)).toBe(1);
    expect(new TextDecoder().decode(app.downloads[1]!.bytes)).toContain("1,6,apple");
    expect(app.bridge.fileStore.writes).toEqual([]);
  });

  it("opens from this computer from the File tab", async () => {
    const app = await renderWithWorkbook("Reports/Budget.xlsx");
    chooseOnComputer(new File([(await workbookBytes()) as BlobPart], "Other.xlsx"));
    openBackstageItem("Open from this computer");
    await flush();
    await flush();
    expect(screen.getByRole("heading", { name: "Other.xlsx" })).toBeTruthy();
    expect(app.session().getState().source).toBe("local");
  });
});
