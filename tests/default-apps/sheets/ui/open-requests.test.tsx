// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { createRecentFiles } from "../../../../home/apps/sheets/src/session";
import { encode } from "../session/fakes";
import { flush, renderApp, renderWithWorkbook, workbookBytes } from "./harness";

afterEach(cleanup);

/** Types `text` into the cell editor of A1 without entering it. */
function typeInEditor(app: Awaited<ReturnType<typeof renderWithWorkbook>>, text: string): void {
  const grid = app.container.querySelector<HTMLElement>("[role='grid']")!;
  act(() => grid.focus());
  fireEvent.keyDown(grid, { key: "F2" });
  const input = app.container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea")!;
  fireEvent.change(input, { target: { value: text } });
}

/** jsdom's TextEncoder returns bytes of another realm, which the engine rejects as not a Uint8Array. */
function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Array.from(encode(text)));
}

describe("Sheets open requests", () => {
  it("opens the file Files asked for on load, once", async () => {
    const app = await renderWithWorkbook("Documents/Budget.xlsx");
    expect(screen.getByRole("heading", { name: "Budget.xlsx" })).toBeTruthy();
    expect(app.bridge.openRequestCalls).toBe(1);
    expect(app.session().getState().path).toBe("Documents/Budget.xlsx");
    expect(app.container.querySelector("[role='gridcell'][data-row='0'][data-col='1']")?.textContent).toBe("6");
    expect(app.bridge.db.recentPaths()).toEqual(["Documents/Budget.xlsx"]);
  });

  it("switches to a file requested while running, saving pending edits first", async () => {
    const app = await renderWithWorkbook("One.xlsx");
    app.bridge.fileStore.put("Two.csv", encode("a,b\n1,2\n"));
    act(() => {
      app.session().setCellInput(app.session().getState().activeSheetId, { row: 5, col: 0 }, "kept");
    });
    act(() => app.bridge.requestOpen("Two.csv"));
    await flush();
    expect(screen.getByRole("heading", { name: "Two.csv" })).toBeTruthy();
    expect(app.bridge.fileStore.writes.map((write) => write.path)).toEqual(["One.xlsx"]);
  });

  it("stores the text still in the cell editor before a requested file replaces the workbook", async () => {
    const app = await renderWithWorkbook("One.xlsx");
    app.bridge.fileStore.put("Two.csv", encode("a,b\n1,2\n"));
    const one = app.session();
    typeInEditor(app, "typed, not entered");
    act(() => app.bridge.requestOpen("Two.csv"));
    await flush();
    expect(screen.getByRole("heading", { name: "Two.csv" })).toBeTruthy();
    expect(one.isDisposed).toBe(true);
    const saved = await openXlsx(app.bridge.fileStore.bytes("One.xlsx"));
    expect(saved.getCell(saved.listSheets()[0]!.id, { row: 0, col: 0 }).value).toBe("typed, not entered");
  });

  it("stays on the workbook with its editor open when a requested file arrives while the editor's text is refused", async () => {
    const app = await renderWithWorkbook("One.xlsx");
    app.bridge.fileStore.put("Two.csv", encode("a,b\n1,2\n"));
    typeInEditor(app, "=1+");
    act(() => app.bridge.requestOpen("Two.csv"));
    await flush();
    expect(screen.getByRole("heading", { name: "One.xlsx" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(app.container.querySelector<HTMLTextAreaElement>(".sg-input--cell textarea")?.value).toBe("=1+");
    expect(app.bridge.fileStore.writes).toEqual([]);
  });

  it("explains a file it cannot read and never writes to it", async () => {
    const app = await renderApp((bridge) => {
      bridge.fileStore.put("Broken.xlsx", bytesOf("PK\u0003\u0004 this is not a whole zip file"));
      bridge.pendingRequest = { path: "Broken.xlsx", requestedAt: "", nonce: "x" };
    });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Sheets cannot open this kind of file")).toBeTruthy();
    expect(alert.textContent).toContain("The file was not changed");
    expect(app.bridge.fileStore.writes).toHaveLength(0);
    expect(app.host.session).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    await flush();
    expect(screen.getByRole("button", { name: /^Blank workbook/ })).toBeTruthy();
  });

  it("keeps the open workbook and says so when a requested file does not open", async () => {
    const app = await renderWithWorkbook("Good.xlsx");
    act(() => app.bridge.requestOpen("Missing.xlsx"));
    await flush();
    expect(screen.getByRole("heading", { name: "Good.xlsx" })).toBeTruthy();
    expect(screen.getByText("Missing.xlsx could not be opened")).toBeTruthy();
  });

  it("asks before dropping edits that cannot be saved", async () => {
    const app = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /^Blank workbook/ }));
    await flush();
    act(() => {
      app.session().setCellInput(app.session().getState().activeSheetId, { row: 0, col: 0 }, "draft");
    });
    app.bridge.fileStore.put("Other.xlsx", await workbookBytes());
    act(() => app.bridge.requestOpen("Other.xlsx"));
    await flush();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("never saved");
    for (const choice of ["Save", "Discard", "Cancel"]) expect(within(dialog).getByRole("button", { name: choice })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Other.xlsx" })).toBeTruthy();
  });
});

describe("Sheets start screen", () => {
  it("lists recent workbooks, opens from the Matrix files and imports pasted CSV", async () => {
    const app = await renderApp(async (bridge) => {
      bridge.fileStore.put("Reports/Q3.xlsx", await workbookBytes());
      bridge.fileStore.put("Reports/notes.txt", encode("x"));
      await createRecentFiles(bridge.db).touch("Reports/Q3.xlsx");
    });
    expect(screen.getByRole("button", { name: /^Q3\.xlsx, in Reports/ })).toBeTruthy();

    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Folder Reports" }));
    await flush();
    const list = screen.getByRole("list", { name: "Folders and files" });
    expect(within(list).queryByText("notes.txt")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /^Q3\.xlsx/ }));
    await flush();
    expect(screen.getByRole("heading", { name: "Q3.xlsx" })).toBeTruthy();

    await act(async () => {
      await app.host.close({ discardUnsaved: true });
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
    fireEvent.change(screen.getByLabelText("Text to import"), { target: { value: "Item,Cost\nTea,3.5\nTrick,=1+1" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await flush();
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    expect(session.getState().name).toBe("Imported.xlsx");
    expect(session.cell(sheet, 1, 1).value).toBe(3.5);
    expect(session.cell(sheet, 2, 1)).toMatchObject({ value: "=1+1", formula: null });
  });
});
