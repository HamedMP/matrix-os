import { describe, expect, it, vi } from "vitest";
import { RECENT_FILES_TABLE, RecentFilesStore } from "../../../../home/apps/docs/src/session/index";
import { createFakeDb, type FakeDb } from "./fakes";
import { harness } from "./helpers";

function store(limit = 3) {
  const db = createFakeDb();
  let tick = 0;
  const recents = new RecentFilesStore({ db, limit, now: () => new Date(Date.UTC(2026, 10, 23, 10, 0, tick++)), log: () => undefined });
  return { db, recents };
}

/** The entries in the stored list row, read straight from the table. */
function storedEntries(db: FakeDb): unknown[] {
  const rows = db.rows(RECENT_FILES_TABLE);
  expect(rows).toHaveLength(1);
  return (rows[0]?.payload as { entries: unknown[] }).entries;
}

describe("recent files", () => {
  it("lists documents newest first and moves a reopened one to the top", async () => {
    const { recents, db } = store();
    await recents.touch({ path: "Documents/a.docx", name: "a.docx" });
    await recents.touch({ path: "Documents/b.docx", name: "b.docx" });
    await recents.touch({ path: "Documents/a.docx", name: "a.docx" });
    expect((await recents.list()).map((entry) => entry.path)).toEqual(["Documents/a.docx", "Documents/b.docx"]);
    expect(storedEntries(db)).toHaveLength(2);
  });

  it("keeps at most the configured number of entries", async () => {
    const { recents, db } = store(3);
    for (const name of ["a", "b", "c", "d", "e"]) await recents.touch({ path: `${name}.docx`, name: `${name}.docx` });
    expect((await recents.list()).map((entry) => entry.name)).toEqual(["e.docx", "d.docx", "c.docx"]);
    expect(storedEntries(db)).toHaveLength(3);
  });

  it("removes an entry and ignores entries it cannot read", async () => {
    const { recents, db } = store();
    await recents.touch({ path: "a.docx", name: "a.docx" });
    const [row] = db.rows(RECENT_FILES_TABLE);
    const payload = row?.payload as { entries: unknown[] };
    const tampered = {
      ...payload,
      entries: [{ path: 42, name: null, openedAt: "2026-11-23T11:00:00.000Z" }, { path: "../escape.docx", name: "x", openedAt: "2026-11-23T11:00:01.000Z" }, ...payload.entries],
    };
    expect(await db.compareAndSwap(RECENT_FILES_TABLE, String(row?.id), payload, { payload: tampered })).toEqual({ ok: true });
    expect((await recents.list()).map((entry) => entry.path)).toEqual(["a.docx"]);
    await recents.remove("a.docx");
    expect(await recents.list()).toEqual([]);
  });

  it("records each change with one database statement", async () => {
    const { recents, db } = store(3);
    for (const name of ["a", "b", "c", "d", "b"]) await recents.touch({ path: `${name}.docx`, name: `${name}.docx` });
    await recents.remove("c.docx");
    // bulkInsert (ON CONFLICT DO NOTHING) creates the list once; every later change is one compare-and-swap.
    expect(db.writes).toEqual([`bulkInsert ${RECENT_FILES_TABLE}`, ...Array.from({ length: 5 }, () => `compareAndSwap ${RECENT_FILES_TABLE}`)]);
    expect(db.rows(RECENT_FILES_TABLE)).toHaveLength(1);
    expect((await recents.list()).map((entry) => entry.path)).toEqual(["b.docx", "d.docx"]);
  });

  it("keeps every document when two windows change the list at the same time", async () => {
    const db = createFakeDb();
    const first = new RecentFilesStore({ db, log: () => undefined });
    const second = new RecentFilesStore({ db, log: () => undefined });
    await Promise.all([first.touch({ path: "a.docx", name: "a.docx" }), second.touch({ path: "b.docx", name: "b.docx" })]);
    await Promise.all([first.touch({ path: "c.docx", name: "c.docx" }), second.touch({ path: "d.docx", name: "d.docx" })]);
    expect(db.rows(RECENT_FILES_TABLE)).toHaveLength(1);
    expect((await first.list()).map((entry) => entry.path).sort()).toEqual(["a.docx", "b.docx", "c.docx", "d.docx"]);
  });

  it("returns an empty list and logs when the store is unavailable", async () => {
    const db = createFakeDb();
    const log = vi.fn();
    const recents = new RecentFilesStore({ db, log });
    db.failNext();
    expect(await recents.list()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("is updated by the session when a document opens or is saved under a new path", async () => {
    const db = createFakeDb();
    const recents = new RecentFilesStore({ db, log: () => undefined });
    const { session } = await harness({ "a.docx": ["Alpha"], "b.docx": ["Beta"] }, { recents });
    await session.open("a.docx");
    await session.open("b.docx");
    await session.saveAs("Documents/c.docx");
    await vi.waitFor(async () => expect((await recents.list()).map((entry) => entry.path)).toEqual(["Documents/c.docx", "b.docx", "a.docx"]));
  });

  it("does not stop a document from opening when the store fails", async () => {
    const db = createFakeDb();
    const recents = new RecentFilesStore({ db, log: () => undefined });
    const { session } = await harness({ "a.docx": ["Alpha"] }, { recents });
    db.failNext();
    expect(await session.open("a.docx")).toEqual({ status: "opened", path: "a.docx" });
  });
});
