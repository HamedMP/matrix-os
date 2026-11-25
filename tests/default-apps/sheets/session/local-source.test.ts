/**
 * A workbook opened from this computer is a LOCAL document: no Matrix path,
 * no automatic save, saved by downloading it again, and it becomes a normal
 * Matrix document once a copy is saved to Matrix.
 */
import { describe, expect, it } from "vitest";
import { createXlsx, openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { runProposal } from "../../../../home/apps/sheets/src/agent";
import { SessionHost, exportSessionFile, openLocalSheetSession, openSheetSession } from "../../../../home/apps/sheets/src/session";
import { saveDocument } from "../../../../home/apps/sheets/src/ui/file-actions";
import { encode, harness, sampleXlsx, settle } from "./fakes";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("a workbook opened from this computer", () => {
  it("is a local document without a path, autosave or a recent-files entry", async () => {
    const h = harness();
    const session = await openLocalSheetSession(h.deps, "Budget.xlsx", await sampleXlsx());
    await settle();
    expect(session.getState()).toMatchObject({ source: "local", path: null, name: "Budget.xlsx", format: "xlsx", autosave: false, dirty: false });
    expect(h.db.rows).toEqual([]);

    const sheet = session.getState().activeSheetId;
    session.setCellInput(sheet, { row: 0, col: 0 }, "40");
    expect(session.getState().dirty).toBe(true);
    expect(h.timers.pending.size).toBe(0);
    expect(await session.flush()).toEqual({ status: "unchanged" });
    expect(h.files.writes).toEqual([]);
  });

  it("is saved by exporting the updated file under the same name, which counts as saved", async () => {
    const h = harness();
    const session = await openLocalSheetSession(h.deps, "Budget.xlsx", await sampleXlsx());
    const sheet = session.getState().activeSheetId;
    session.setCellInput(sheet, { row: 0, col: 0 }, "40");

    const file = await exportSessionFile(session);
    expect(file).toMatchObject({ ok: true, name: "Budget.xlsx", mimeType: XLSX_MIME });
    if (!file.ok) throw new Error("export failed");
    const saved = await openXlsx(file.bytes);
    const id = saved.listSheets()[0]!.id;
    expect(saved.getCell(id, { row: 0, col: 0 }).value).toBe(40);
    expect(session.getState().dirty).toBe(true);

    session.markDownloaded();
    expect(session.getState()).toMatchObject({ dirty: false, saveState: "saved", source: "local" });
    expect(h.files.writes).toEqual([]);
  });

  it("keeps an edit made while the download was being packed unsaved", async () => {
    const h = harness();
    const session = await openLocalSheetSession(h.deps, "Budget.xlsx", await sampleXlsx());
    const sheet = session.getState().activeSheetId;
    session.setCellInput(sheet, { row: 0, col: 0 }, "40");
    const downloads: Uint8Array[] = [];
    const saving = saveDocument(session, (_name, bytes) => downloads.push(bytes), () => undefined);
    // The export is still being packed: this edit is not in the file that is downloaded.
    session.setCellInput(sheet, { row: 0, col: 1 }, "late");

    expect(await saving).toBe("saved");
    expect(downloads).toHaveLength(1);
    const saved = await openXlsx(downloads[0]!);
    expect(saved.getCell(saved.listSheets()[0]!.id, { row: 0, col: 1 }).value).not.toBe("late");
    expect(session.getState().dirty).toBe(true);
    expect(session.getState().saveState).not.toBe("saved");
  });

  it("writes a CSV back in the delimiter it was read with, and downloads a copy as .xlsx", async () => {
    const h = harness();
    const session = await openLocalSheetSession(h.deps, "data.csv", encode("name;amount\nTea;3\n"));
    expect(session.getState()).toMatchObject({ format: "csv", name: "data.csv", source: "local" });
    session.setCellInput(session.getState().activeSheetId, { row: 1, col: 1 }, "4");

    const csv = await exportSessionFile(session);
    if (!csv.ok) throw new Error("export failed");
    expect(csv.name).toBe("data.csv");
    expect(csv.mimeType).toBe("text/csv");
    expect(new TextDecoder().decode(csv.bytes)).toBe("name;amount\nTea;4\n");

    const copy = await exportSessionFile(session, "xlsx");
    if (!copy.ok) throw new Error("export failed");
    expect(copy).toMatchObject({ name: "data.xlsx", mimeType: XLSX_MIME });
    const workbook = await openXlsx(copy.bytes);
    expect(workbook.getCell(workbook.listSheets()[0]!.id, { row: 1, col: 1 }).value).toBe(4);
  });

  it("does not bake suggested changes into a CSV download, but an .xlsx copy keeps them for review", async () => {
    const h = harness();
    const session = await openLocalSheetSession(h.deps, "data.csv", encode("name,amount\nA,10\n"));
    const sheet = session.getState().activeSheetId;
    runProposal(session, "Raise A", "2026-11-23T10:00:00.000Z", [], (workbook) => workbook.setCell(sheet, { row: 1, col: 1 }, 999));
    expect(await exportSessionFile(session)).toMatchObject({ ok: false, code: "review_pending" });
    const copy = await exportSessionFile(session, "xlsx");
    if (!copy.ok) throw new Error("export failed");
    expect((await openXlsx(copy.bytes)).listChanges()).toHaveLength(1);
  });

  it("becomes a normal Matrix document once a copy is saved to Matrix", async () => {
    const h = harness();
    const session = await openLocalSheetSession(h.deps, "Budget.xlsx", await sampleXlsx());
    const sheet = session.getState().activeSheetId;
    session.setCellInput(sheet, { row: 0, col: 0 }, "40");

    const outcome = await session.saveAs("Documents/Budget.xlsx");
    await settle();
    expect(outcome).toEqual({ status: "saved", path: "Documents/Budget.xlsx" });
    expect(session.getState()).toMatchObject({ source: "matrix", path: "Documents/Budget.xlsx", autosave: true, dirty: false });
    expect(h.db.recentPaths()).toEqual(["Documents/Budget.xlsx"]);

    session.setCellInput(sheet, { row: 0, col: 0 }, "41");
    expect(h.timers.pending.size).toBe(1);
    h.timers.fire();
    await settle();
    expect(h.files.writes.map((write) => write.path)).toEqual(["Documents/Budget.xlsx", "Documents/Budget.xlsx"]);
  });

  it("refuses a file that is not a spreadsheet with a message that is safe to show", async () => {
    const h = harness();
    await expect(openLocalSheetSession(h.deps, "notes.txt", encode("x"))).rejects.toMatchObject({ code: "unsupported" });
    await expect(openLocalSheetSession(h.deps, "broken.xlsx", encode("not a zip"))).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("downloading a copy of a Matrix document", () => {
  it("exports the workbook without changing its path or saved state", async () => {
    const h = harness();
    h.files.put("Documents/Plan.xlsx", await sampleXlsx());
    const session = await openSheetSession(h.deps, "Documents/Plan.xlsx");
    session.setCellInput(session.getState().activeSheetId, { row: 0, col: 0 }, "7");
    const file = await exportSessionFile(session, "xlsx");
    expect(file).toMatchObject({ ok: true, name: "Plan.xlsx" });
    expect(session.getState()).toMatchObject({ source: "matrix", path: "Documents/Plan.xlsx", dirty: true });
  });
});

describe("recalculating on request", () => {
  it("recalculates and tells listeners without marking the workbook edited", async () => {
    const h = harness();
    const wb = createXlsx();
    wb.setFormula(wb.listSheets()[0]!.id, { row: 0, col: 0 }, "1+1");
    h.files.put("Book.xlsx", await wb.save());
    const session = await openSheetSession(h.deps, "Book.xlsx");
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    const before = session.getState().revision;
    session.recalculate();
    expect(events).toEqual(["change"]);
    expect(session.getState().revision).toBe(before + 1);
    expect(session.getState().dirty).toBe(false);
    expect(session.cell(session.getState().activeSheetId, 0, 0).value).toBe(2);
  });
});

describe("the session host with local documents", () => {
  it("opens a local file, keeps it when its edits are not downloaded, and drops it on discard", async () => {
    const h = harness();
    const host = new SessionHost(h.deps);
    const opened = await host.openLocal("Budget.xlsx", await sampleXlsx());
    expect(opened.status).toBe("opened");
    const session = host.session!;
    session.setCellInput(session.getState().activeSheetId, { row: 0, col: 0 }, "9");
    expect(await host.close()).toBe(false);
    expect(host.session).toBe(session);
    session.markDownloaded();
    expect(await host.close()).toBe(true);
    expect(host.session).toBeNull();
  });

  it("keeps the open workbook and shows no error page when a local file does not open", async () => {
    const h = harness();
    h.files.put("Good.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    await host.open("Good.xlsx");
    const result = await host.openLocal("broken.xlsx", encode("nope"));
    expect(result).toMatchObject({ status: "error", code: "unsupported" });
    expect(host.getState()).toMatchObject({ error: null, opening: null });
    expect(host.session?.getState().path).toBe("Good.xlsx");
  });

  it("asks before replacing a workbook whose edits are not saved", async () => {
    const h = harness();
    const host = new SessionHost(h.deps);
    await host.openNew();
    host.session!.setCellInput(host.session!.getState().activeSheetId, { row: 0, col: 0 }, "x");
    expect(await host.openLocal("Budget.xlsx", await sampleXlsx())).toEqual({ status: "unsaved" });
    expect((await host.openLocal("Budget.xlsx", await sampleXlsx(), { discardUnsaved: true })).status).toBe("opened");
    expect(host.session?.getState().source).toBe("local");
  });
});
