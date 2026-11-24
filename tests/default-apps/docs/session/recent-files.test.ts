import { describe, expect, it, vi } from "vitest";
import { RECENT_FILES_TABLE, RecentFilesStore } from "../../../../home/apps/docs/src/session/index";
import { createFakeDb } from "./fakes";
import { harness } from "./helpers";

function store(limit = 3) {
  const db = createFakeDb();
  let tick = 0;
  const recents = new RecentFilesStore({ db, limit, now: () => new Date(Date.UTC(2026, 10, 23, 10, 0, tick++)), log: () => undefined });
  return { db, recents };
}

describe("recent files", () => {
  it("lists documents newest first and moves a reopened one to the top", async () => {
    const { recents, db } = store();
    await recents.touch({ path: "Documents/a.docx", name: "a.docx" });
    await recents.touch({ path: "Documents/b.docx", name: "b.docx" });
    await recents.touch({ path: "Documents/a.docx", name: "a.docx" });
    expect((await recents.list()).map((entry) => entry.path)).toEqual(["Documents/a.docx", "Documents/b.docx"]);
    expect(db.rows(RECENT_FILES_TABLE)).toHaveLength(2);
  });

  it("keeps at most the configured number of entries", async () => {
    const { recents, db } = store(3);
    for (const name of ["a", "b", "c", "d", "e"]) await recents.touch({ path: `${name}.docx`, name: `${name}.docx` });
    expect((await recents.list()).map((entry) => entry.name)).toEqual(["e.docx", "d.docx", "c.docx"]);
    expect(db.rows(RECENT_FILES_TABLE)).toHaveLength(3);
  });

  it("removes an entry and ignores rows it cannot read", async () => {
    const { recents, db } = store();
    await recents.touch({ path: "a.docx", name: "a.docx" });
    await db.insert(RECENT_FILES_TABLE, { path: 42, name: null, opened_at: "2026-11-23T11:00:00.000Z" });
    await db.insert(RECENT_FILES_TABLE, { path: "../escape.docx", name: "x", opened_at: "2026-11-23T11:00:01.000Z" });
    expect((await recents.list()).map((entry) => entry.path)).toEqual(["a.docx"]);
    await recents.remove("a.docx");
    expect(await recents.list()).toEqual([]);
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
