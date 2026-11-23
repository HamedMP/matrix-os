import { describe, expect, it } from "vitest";
import { openXlsx } from "../../../../home/apps/_shared/office-engine/index";
import { type SessionEvent, SheetSessionError, openSheetSession } from "../../../../home/apps/sheets/src/session";
import { type Harness, encode, harness, sampleXlsx, settle } from "./fakes";

async function open(h: Harness = harness(), path = "Docs/Budget.xlsx") {
  if (!h.files.store.has(path)) h.files.put(path, await sampleXlsx());
  const session = await openSheetSession(h.deps, path);
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { h, session, sheet: session.getState().activeSheetId, events };
}

async function a1(bytes: Uint8Array): Promise<unknown> {
  const workbook = await openXlsx(bytes);
  return workbook.getCell(workbook.listSheets()[0]!.id, { row: 0, col: 0 }).value;
}

describe("sheet session saving", () => {
  it("saves with the version it read and takes the new version for the next save", async () => {
    const { h, session, sheet } = await open();
    const readVersion = h.files.store.get("Docs/Budget.xlsx")!.version;
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");

    expect(await session.save()).toEqual({ status: "saved", path: "Docs/Budget.xlsx" });
    expect(h.files.writes).toEqual([expect.objectContaining({ path: "Docs/Budget.xlsx", ifVersion: readVersion })]);
    expect(await a1(h.files.bytes("Docs/Budget.xlsx"))).toBe(5);
    expect(session.getState()).toMatchObject({ dirty: false, saveState: "saved", lastSavedAt: h.clock.now });

    session.setCellInput(sheet, { row: 0, col: 0 }, "6");
    await session.save();
    expect(h.files.writes[1]!.ifVersion).toBe("v2");
    expect(await session.save()).toEqual({ status: "unchanged" });
    expect(h.files.writes).toHaveLength(2);
  });

  it("reports a conflict, keeps the local workbook and stops saving until the owner decides", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.files.put("Docs/Budget.xlsx", await sampleXlsx());

    expect(await session.save()).toEqual({ status: "conflict" });
    expect(session.getState()).toMatchObject({ saveState: "conflict", dirty: true });
    expect(session.cell(sheet, 0, 0).value).toBe(5);
    expect(await a1(h.files.bytes("Docs/Budget.xlsx"))).toBe(1);

    // More edits do not schedule a save, and an explicit save does not write.
    session.setCellInput(sheet, { row: 1, col: 0 }, "9");
    expect(h.timers.pending.size).toBe(0);
    const writes = h.files.writes.length;
    expect(await session.save()).toEqual({ status: "conflict" });
    expect(h.files.writes).toHaveLength(writes);
    expect(session.getState().saveState).toBe("conflict");
  });

  it("resolves a conflict by saving a copy beside the file and continues there", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.files.put("Docs/Budget.xlsx", await sampleXlsx());
    h.files.put("Docs/Budget (copy).xlsx", encode("taken"));
    await session.save();

    expect(await session.saveCopy()).toEqual({ status: "saved", path: "Docs/Budget (copy 2).xlsx" });
    expect(session.getState()).toMatchObject({ path: "Docs/Budget (copy 2).xlsx", name: "Budget (copy 2).xlsx", saveState: "saved", dirty: false });
    expect(await a1(h.files.bytes("Docs/Budget (copy 2).xlsx"))).toBe(5);
    expect(await a1(h.files.bytes("Docs/Budget.xlsx"))).toBe(1);
    expect(h.files.text("Docs/Budget (copy).xlsx")).toBe("taken");

    session.setCellInput(sheet, { row: 0, col: 0 }, "6");
    expect(await session.save()).toEqual({ status: "saved", path: "Docs/Budget (copy 2).xlsx" });
  });

  it("resolves a conflict by reloading: the file wins and the history is dropped", async () => {
    const { h, session, sheet, events } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    const other = await openXlsx(await sampleXlsx());
    other.setCell(other.listSheets()[0]!.id, { row: 0, col: 0 }, 70);
    h.files.put("Docs/Budget.xlsx", await other.save());
    await session.save();
    events.length = 0;

    expect(await session.reload()).toEqual({ ok: true });
    const active = session.getState().activeSheetId;
    expect(session.cell(active, 0, 0).value).toBe(70);
    expect(session.cell(active, 0, 1).value).toBe(75);
    expect(session.getState()).toMatchObject({ saveState: "idle", dirty: false, canUndo: false });
    expect(events.some((event) => event.type === "change" && event.cause === "load")).toBe(true);

    session.setCellInput(active, { row: 0, col: 0 }, "71");
    expect(await session.save()).toMatchObject({ status: "saved" });
  });

  it("keeps the local workbook when a reload cannot read the file", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.files.store.delete("Docs/Budget.xlsx");
    expect(await session.reload()).toMatchObject({ ok: false, code: "not_found" });
    expect(session.cell(sheet, 0, 0).value).toBe(5);
    expect(session.getState().dirty).toBe(true);
  });

  it("refuses save-as to an existing file or a path it cannot write", async () => {
    const { h, session } = await open();
    h.files.put("Docs/Other.xlsx", encode("x"));
    expect(await session.saveAs("Docs/Other.xlsx")).toMatchObject({ status: "error", code: "exists" });
    expect(await session.saveAs("Docs/notes.txt")).toMatchObject({ status: "error", code: "invalid_path" });
    expect(await session.saveAs("../escape.xlsx")).toMatchObject({ status: "error", code: "invalid_path" });
    expect(session.getState().path).toBe("Docs/Budget.xlsx");
    expect(h.files.text("Docs/Other.xlsx")).toBe("x");
  });

  it("shows a retryable error when the write fails and saves on the next try", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.files.failNext = "unavailable";
    expect(await session.save()).toMatchObject({ status: "error", code: "unavailable" });
    expect(session.getState()).toMatchObject({ saveState: "error", dirty: true, saveError: { code: "unavailable" } });
    expect(await session.save()).toMatchObject({ status: "saved" });
    expect(session.getState()).toMatchObject({ saveState: "saved", saveError: null });
  });
});

describe("sheet session autosave", () => {
  it("saves once after the quiet period, restarting it on every edit", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    expect(session.getState().saveState).toBe("pending");
    session.setCellInput(sheet, { row: 0, col: 0 }, "6");
    expect(h.timers.pending.size).toBe(1);
    expect([...h.timers.pending.values()][0]!.ms).toBe(1000);

    h.timers.fire();
    await settle();
    expect(h.files.writes).toHaveLength(1);
    expect(await a1(h.files.bytes("Docs/Budget.xlsx"))).toBe(6);
    expect(session.getState()).toMatchObject({ dirty: false, saveState: "saved" });
    expect(h.timers.pending.size).toBe(0);
  });

  it("does not write after the session was closed for another document", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    session.dispose();
    expect(h.timers.pending.size).toBe(0);
    h.timers.fire();
    await settle();
    expect(h.files.writes).toHaveLength(0);
  });

  it("ignores the result of a save that settles after the session was closed", async () => {
    const { h, session, sheet, events } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    let release = (): void => undefined;
    h.files.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = session.save();
    await settle();
    const before = session.getState();
    events.length = 0;
    session.dispose();
    release();
    expect(await saving).toEqual({ status: "superseded" });
    expect(session.getState()).toBe(before);
    expect(events).toEqual([]);
  });

  it("does not let a save started before a reload touch the reloaded document", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.timers.fire();
    // The automatic save is queued; a reload asked for right after runs behind it.
    const reloading = session.reload();
    await settle();
    await reloading;
    const version = h.files.store.get("Docs/Budget.xlsx")!.version;
    const active = session.getState().activeSheetId;
    expect(session.getState()).toMatchObject({ dirty: false, saveState: "idle" });
    session.setCellInput(active, { row: 0, col: 0 }, "8");
    expect(await session.save()).toMatchObject({ status: "saved" });
    expect(h.files.writes[h.files.writes.length - 1]!.ifVersion).toBe(version);
  });

  it("saves again when edits arrive while a save is being written", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    let release = (): void => undefined;
    h.files.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = session.save();
    await settle();
    session.setCellInput(sheet, { row: 0, col: 0 }, "6");
    release();
    await saving;
    expect(session.getState()).toMatchObject({ dirty: true, saveState: "pending" });
    h.timers.fire();
    await settle();
    expect(await a1(h.files.bytes("Docs/Budget.xlsx"))).toBe(6);
    expect(session.getState().dirty).toBe(false);
  });

  it("stops automatic saves on a conflict and after autosave is turned off", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.files.put("Docs/Budget.xlsx", await sampleXlsx());
    h.timers.fire();
    await settle();
    expect(session.getState().saveState).toBe("conflict");
    session.setCellInput(sheet, { row: 0, col: 0 }, "6");
    expect(h.timers.pending.size).toBe(0);

    const second = await open(harness());
    second.session.setAutosave(false);
    second.session.setCellInput(second.sheet, { row: 0, col: 0 }, "5");
    expect(second.h.timers.pending.size).toBe(0);
    expect(second.session.getState()).toMatchObject({ autosave: false, saveState: "idle", dirty: true });
  });

  it("retries an automatic save after the file service was unavailable", async () => {
    const { h, session, sheet } = await open();
    session.setCellInput(sheet, { row: 0, col: 0 }, "5");
    h.files.failNext = "unavailable";
    h.timers.fire();
    await settle();
    expect(session.getState().saveState).toBe("error");
    expect([...h.timers.pending.values()].map((timer) => timer.ms)).toEqual([2000]);
    h.timers.fire();
    await settle();
    expect(session.getState()).toMatchObject({ saveState: "saved", dirty: false });
  });
});

describe("sheet session file formats", () => {
  it("opens CSV and writes it back as CSV in the shape it had", async () => {
    const h = harness();
    h.files.put("data.csv", encode("﻿name;amount\nRent;1200\nFood;300\n"));
    const session = await openSheetSession(h.deps, "data.csv");
    const sheet = session.getState().activeSheetId;
    expect(session.getState()).toMatchObject({ format: "csv", valuesOnlyFormat: true });
    expect(session.cell(sheet, 1, 1).value).toBe(1200);

    session.setCellInput(sheet, { row: 3, col: 0 }, "Total");
    session.setCellInput(sheet, { row: 3, col: 1 }, "=SUM(B2:B3)");
    expect(await session.save()).toMatchObject({ status: "saved" });
    const bytes = h.files.bytes("data.csv");
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe("name;amount\nRent;1200\nFood;300\nTotal;1500\n");
  });

  it("opens tab-separated text and can save it as a workbook", async () => {
    const h = harness();
    h.files.put("data.tsv", encode("a\tb\r\n1\t2\r\n"));
    const session = await openSheetSession(h.deps, "data.tsv");
    const sheet = session.getState().activeSheetId;
    expect(session.cell(sheet, 1, 1).value).toBe(2);
    session.setCellInput(sheet, { row: 1, col: 2 }, "=A2+B2");

    expect(await session.saveAs("data.xlsx")).toEqual({ status: "saved", path: "data.xlsx" });
    expect(session.getState()).toMatchObject({ format: "xlsx", valuesOnlyFormat: false, path: "data.xlsx" });
    const reopened = await openXlsx(h.files.bytes("data.xlsx"));
    expect(reopened.getCell(reopened.listSheets()[0]!.id, { row: 1, col: 2 })).toMatchObject({ formula: "A2+B2", value: 3 });
    expect(h.files.text("data.tsv")).toBe("a\tb\r\n1\t2\r\n");
  });

  it("explains a file it cannot open and writes nothing", async () => {
    const h = harness();
    h.files.put("broken.xlsx", encode("this is not a zip archive"));
    await expect(openSheetSession(h.deps, "broken.xlsx")).rejects.toMatchObject({ name: "SheetSessionError", code: "unsupported" });
    await expect(openSheetSession(h.deps, "missing.xlsx")).rejects.toMatchObject({ code: "not_found" });
    await expect(openSheetSession(h.deps, "notes.docx")).rejects.toBeInstanceOf(SheetSessionError);
    expect(h.files.writes).toEqual([]);
  });
});
