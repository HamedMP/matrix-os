import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_FILES,
  SessionHost,
  copyPath,
  createRecentFiles,
  formatOfPath,
  isValidFilePath,
} from "../../../../home/apps/sheets/src/session";
import { sniffDelimiter } from "../../../../home/apps/sheets/src/session/file-io";
import { FakeDb, encode, harness, sampleXlsx, settle } from "./fakes";

describe("recent files", () => {
  it("lists the newest first with one row per path", async () => {
    const db = new FakeDb();
    let now = Date.parse("2026-11-20T10:00:00Z");
    const recents = createRecentFiles(db, { now: () => now });
    await recents.touch("a/One.xlsx");
    now += 1000;
    await recents.touch("Two.csv");
    now += 1000;
    await recents.touch("a/One.xlsx");

    expect(await recents.list()).toEqual([
      { path: "a/One.xlsx", name: "One.xlsx", openedAt: "2026-11-20T10:00:02.000Z" },
      { path: "Two.csv", name: "Two.csv", openedAt: "2026-11-20T10:00:01.000Z" },
    ]);
    expect(db.recentPaths()).toEqual(["a/One.xlsx", "Two.csv"]);
  });

  it("keeps a bounded number of rows and can forget a path", async () => {
    const db = new FakeDb();
    let now = 0;
    const recents = createRecentFiles(db, { now: () => (now += 1000) });
    for (let i = 0; i < MAX_RECENT_FILES + 5; i++) await recents.touch(`file-${i}.xlsx`);
    expect(db.recentPaths()).toHaveLength(MAX_RECENT_FILES);
    const list = await recents.list();
    expect(list[0]!.path).toBe(`file-${MAX_RECENT_FILES + 4}.xlsx`);
    await recents.remove(list[0]!.path);
    expect((await recents.list()).some((entry) => entry.path === list[0]!.path)).toBe(false);
  });

  // Outcome: opening a file updates the list completely or not at all, and windows do not drop each other's entries.
  // Fault: an insert and the clean-up of old rows run as separate writes, so a failure between them, or
  // two windows cleaning up from stale lists, leaves the table half updated.
  it("records each change with one database statement", async () => {
    const db = new FakeDb();
    let now = 0;
    const recents = createRecentFiles(db, { now: () => (now += 1000) });
    for (let i = 0; i < MAX_RECENT_FILES + 2; i++) await recents.touch(`file-${i}.xlsx`);
    await recents.touch("file-5.xlsx");
    await recents.remove("file-6.xlsx");
    await recents.remove("not-listed.xlsx");
    expect(db.writes).toEqual(["bulkInsert recent_files", ...Array.from({ length: MAX_RECENT_FILES + 3 }, () => "compareAndSwap recent_files")]);
    expect(db.rows).toHaveLength(1);
    expect(db.recentPaths()).toHaveLength(MAX_RECENT_FILES - 1);
    expect(db.recentPaths()[0]).toBe("file-5.xlsx");
  });

  it("keeps every file when two windows change the list at the same time", async () => {
    const db = new FakeDb();
    const first = createRecentFiles(db);
    const second = createRecentFiles(db);
    await Promise.all([first.touch("a.xlsx"), second.touch("b.xlsx")]);
    await Promise.all([first.touch("c.xlsx"), second.touch("d.xlsx"), first.remove("a.xlsx")]);
    expect(db.rows).toHaveLength(1);
    expect(db.recentPaths().sort()).toEqual(["b.xlsx", "c.xlsx", "d.xlsx"]);
  });

  it("skips stored entries it cannot read and paths that are not file paths", async () => {
    const db = new FakeDb();
    const recents = createRecentFiles(db);
    await recents.touch("a.xlsx");
    await recents.touch("../escape.xlsx");
    const row = db.rows[0]!;
    const payload = row.payload as { entries: unknown[] };
    row.payload = { entries: [{ path: 42, name: null, openedAt: "2026-11-23T11:00:00.000Z" }, { path: "/abs.xlsx", name: "x", openedAt: "2026-11-23T11:00:01.000Z" }, ...payload.entries] };
    expect((await recents.list()).map((entry) => entry.path)).toEqual(["a.xlsx"]);
  });

  it("never fails the caller when the store is down or missing", async () => {
    const db = new FakeDb();
    db.fail = true;
    const logged: string[] = [];
    const recents = createRecentFiles(db, { log: (message) => logged.push(message) });
    await expect(recents.touch("x.xlsx")).resolves.toBeUndefined();
    expect(await recents.list()).toEqual([]);
    expect(logged).toHaveLength(2);
    expect(await createRecentFiles(null).list()).toEqual([]);
  });

  it("records opened and saved-as files from a session", async () => {
    const h = harness();
    h.files.put("Budget.xlsx", await sampleXlsx());
    const host = new SessionHost(h.deps);
    const opened = await host.open("Budget.xlsx");
    await settle();
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    await opened.session.saveAs("Plan.xlsx");
    await settle();
    expect((await opened.session.recents.list()).map((entry) => entry.path).sort()).toEqual(["Budget.xlsx", "Plan.xlsx"]);
  });
});

describe("path helpers", () => {
  it("names copies beside the file", () => {
    expect(copyPath("a/Budget.xlsx")).toBe("a/Budget (copy).xlsx");
    expect(copyPath("a/Budget.xlsx", 3)).toBe("a/Budget (copy 3).xlsx");
    expect(copyPath("Budget (copy).xlsx", 2)).toBe("Budget (copy 2).xlsx");
    expect(copyPath("data.csv")).toBe("data (copy).csv");
  });

  it("knows the formats it writes and the paths the bridge accepts", () => {
    expect(formatOfPath("A.XLSX")).toBe("xlsx");
    expect(formatOfPath("a.csv")).toBe("csv");
    expect(formatOfPath("a.tsv")).toBe("tsv");
    expect(formatOfPath("a.xls")).toBeNull();
    expect(isValidFilePath("Docs/a.xlsx")).toBe(true);
    for (const bad of ["", "/a.xlsx", "a/", "a//b.xlsx", "a/../b.xlsx", "a\\b.xlsx", "./a.xlsx"]) expect(isValidFilePath(bad)).toBe(false);
  });

  it("detects the delimiter outside quoted fields", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter('"x,y,z,w";b\n1;2')).toBe(";");
    expect(sniffDelimiter("a\tb")).toBe("\t");
    expect(sniffDelimiter("single")).toBe(",");
  });
});

describe("session host", () => {
  it("keeps the latest of two overlapping opens and closes the other", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.csv", encode("x,y\n1,2\n"));
    const host = new SessionHost(h.deps);

    const first = host.open("A.xlsx");
    const second = host.open("B.csv");
    expect(await first).toEqual({ status: "superseded" });
    const opened = await second;
    expect(opened.status).toBe("opened");
    expect(host.session?.getState().path).toBe("B.csv");
    expect(host.getState()).toMatchObject({ opening: null, error: null });
  });

  it("saves pending edits of the document it leaves, to that document's path", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.csv", encode("x,y\n1,2\n"));
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    a.session.setCellInput(a.session.getState().activeSheetId, { row: 0, col: 0 }, "42");

    const b = await host.open("B.csv");
    expect(b.status).toBe("opened");
    expect(h.files.writes.map((write) => write.path)).toEqual(["A.xlsx"]);
    expect(a.session.isDisposed).toBe(true);
    expect(h.timers.pending.size).toBe(0);
    expect(h.files.text("B.csv")).toBe("x,y\n1,2\n");
  });

  it("stays on a document whose edits cannot be saved unless told to discard them", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("B.csv", encode("x,y\n1,2\n"));
    const host = new SessionHost(h.deps);
    const a = await host.open("A.xlsx");
    if (a.status !== "opened") throw new Error("not opened");
    a.session.setCellInput(a.session.getState().activeSheetId, { row: 0, col: 0 }, "42");
    h.files.put("A.xlsx", await sampleXlsx());

    expect(await host.open("B.csv")).toEqual({ status: "unsaved" });
    expect(host.session).toBe(a.session);
    expect(a.session.getState().saveState).toBe("conflict");

    expect((await host.open("B.csv", { discardUnsaved: true })).status).toBe("opened");
    expect(host.session?.getState().path).toBe("B.csv");
  });

  it("reports a file that cannot be opened and keeps the current document", async () => {
    const h = harness();
    h.files.put("A.xlsx", await sampleXlsx());
    h.files.put("bad.xlsx", encode("nope"));
    const host = new SessionHost(h.deps);
    await host.open("A.xlsx");
    const result = await host.open("bad.xlsx");
    expect(result).toMatchObject({ status: "error", code: "unsupported" });
    expect(host.getState().error).toMatchObject({ code: "unsupported", path: "bad.xlsx" });
    expect(host.session?.getState().path).toBe("A.xlsx");
    expect(h.files.text("bad.xlsx")).toBe("nope");
  });

  it("starts a new workbook and closes", async () => {
    const h = harness();
    const host = new SessionHost(h.deps);
    const created = await host.openNew();
    expect(created.status).toBe("opened");
    expect(host.session?.getState().path).toBeNull();
    expect(await host.close()).toBe(true);
    expect(host.session).toBeNull();
  });
});
