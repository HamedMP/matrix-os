// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { createRecentFiles } from "../../../../home/apps/sheets/src/session";
import { buildTemplate } from "../../../../home/apps/sheets/src/ui/templates";
import { encode } from "../session/fakes";
import { flush, renderApp, workbookBytes } from "./harness";

afterEach(cleanup);

describe("Sheets start screen", () => {
  it("lists only folders and spreadsheets from Matrix, and filters them by name", async () => {
    await renderApp(async (bridge) => {
      bridge.fileStore.put("Reports/Q3.xlsx", await workbookBytes());
      bridge.fileStore.put("Reports/q3-raw.csv", encode("a,b\n"));
      bridge.fileStore.put("Reports/q4.tsv", encode("a\tb\n"));
      bridge.fileStore.put("Reports/notes.txt", encode("x"));
      bridge.fileStore.put("Reports/brief.docx", encode("x"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Folder Reports" }));
    await flush();
    const list = screen.getByRole("list", { name: "Folders and files" });
    expect(within(list).getAllByRole("button").map((button) => button.querySelector(".oui-browser__name")?.textContent)).toEqual(["q3-raw.csv", "Q3.xlsx", "q4.tsv"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter this folder by name" }), { target: { value: "q3" } });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("button", { name: "Reports" }).getAttribute("aria-current")).toBe("location");
  });

  it("starts the Matrix browser in the folder last used, and remembers the next one", async () => {
    const app = await renderApp(async (bridge) => {
      bridge.fileStore.put("Work/Q3/plan.xlsx", await workbookBytes());
      bridge.fileStore.put("Work/budget.xlsx", await workbookBytes());
      await bridge.writeData("start_folder", { dir: "Work/Q3" });
    });
    await flush();
    const list = screen.getByRole("list", { name: "Folders and files" });
    expect(within(list).getAllByRole("button").map((button) => button.querySelector(".oui-browser__name")?.textContent)).toEqual(["plan.xlsx"]);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("button", { name: "Work" }));
    await flush();
    expect(await app.bridge.readData("start_folder")).toEqual({ dir: "Work" });
  });

  it("starts in documents when no folder is remembered", async () => {
    await renderApp(async (bridge) => {
      bridge.fileStore.put("documents/q1.xlsx", await workbookBytes());
      bridge.fileStore.put("elsewhere.xlsx", await workbookBytes());
    });
    await flush();
    const list = screen.getByRole("list", { name: "Folders and files" });
    expect(within(list).getAllByRole("button").map((button) => button.querySelector(".oui-browser__name")?.textContent)).toEqual(["q1.xlsx"]);
  });

  it("removes a workbook from the recent list", async () => {
    const app = await renderApp(async (bridge) => {
      await createRecentFiles(bridge.db).touch("Q3.xlsx");
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove Q3.xlsx from recent" }));
    await flush();
    expect(screen.getByRole("heading", { name: "No recent workbooks" })).toBeTruthy();
    expect(app.bridge.db.recentPaths()).toEqual([]);
  });

  it("starts a budget from its template, calculated and unsaved", async () => {
    const app = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /^Budget/ }));
    await flush();
    const session = app.session();
    const state = session.getState();
    expect(state.name).toBe("Budget.xlsx");
    expect(state.path).toBeNull();
    const sheet = state.activeSheetId;
    expect(session.cell(sheet, 2, 0).value).toBe("Category");
    expect(session.cell(sheet, 10, 1)).toMatchObject({ value: 3000, formula: "SUM(B4:B10)" });
    expect(app.bridge.fileStore.writes).toEqual([]);
  });
});

describe("Sheets templates", () => {
  it("save as workbooks the engine reopens with their formulas, styles and frozen header", async () => {
    const budget = await openXlsx(await buildTemplate("budget")!.save());
    const sheet = budget.listSheets()[0]!;
    expect(sheet.name).toBe("Budget");
    expect(budget.getCell(sheet.id, { row: 3, col: 3 })).toMatchObject({ formula: "B4-C4", value: 1500 });
    expect(budget.getCell(sheet.id, { row: 10, col: 3 }).value).toBe(3000);
    expect(budget.getStyle(budget.getCell(sheet.id, { row: 2, col: 0 }).styleId).font.bold).toBe(true);
    expect(budget.getSheet(sheet.id).frozen).toEqual({ rows: 3, cols: 0 });

    const tracker = await openXlsx(await buildTemplate("task-tracker")!.save());
    const tasks = tracker.listSheets()[0]!;
    expect(tracker.getCell(tasks.id, { row: 0, col: 2 }).value).toBe("Status");
    tracker.recalc();
    expect([1, 2, 3].map((row) => tracker.getCell(tasks.id, { row, col: 7 }).value)).toEqual([1, 1, 1]);
    expect(tracker.getCell(tasks.id, { row: 1, col: 3 }).display).toBe("2026-12-01");
    expect(buildTemplate("blank")).toBeNull();
  });
});
