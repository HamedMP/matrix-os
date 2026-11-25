import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAIL_CACHE_TABLES, createDbMailCache } from "../../../../home/apps/mail/src/model/cache";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { VOICE_TABLE } from "../../../../home/apps/mail/src/agent/voice-cache";
import { GMAIL, GMAIL_FOLDERS, OUTLOOK, page, summary } from "./fixtures";
import { mailFakeDb } from "./fake-db";

const silent = vi.fn();

describe("db mail cache", () => {
  it("round-trips summaries, reply data, folders and snoozes", async () => {
    const db = mailFakeDb();
    const cache = createDbMailCache(db, { logger: silent });
    const meta = { lastFrom: "alice@example.com", lastAt: "2026-11-10T09:00:00Z", ownerSentLast: false };
    await cache.saveThreads([{ summary: summary("t1"), replyMeta: meta }, { summary: summary("t2"), replyMeta: null }]);
    await cache.saveFolders(GMAIL.id, GMAIL_FOLDERS);
    await cache.saveSnoozes({ [threadKey(GMAIL.id, "t1")]: { accountId: GMAIL.id, until: "2026-11-20T08:00:00Z" } });
    const loaded = await cache.load([GMAIL.id]);
    expect(loaded.threads.map((s) => s.id).sort()).toEqual(["t1", "t2"]);
    expect(loaded.replyMeta).toEqual({ [threadKey(GMAIL.id, "t1")]: meta });
    expect(loaded.folders[GMAIL.id]).toEqual(GMAIL_FOLDERS);
    expect(loaded.snoozes).toEqual({ [threadKey(GMAIL.id, "t1")]: "2026-11-20T08:00:00Z" });
  });

  it("updates an existing row instead of inserting a duplicate", async () => {
    const db = mailFakeDb();
    const cache = createDbMailCache(db, { logger: silent });
    await cache.saveThreads([{ summary: summary("t1", { subject: "old" }), replyMeta: null }]);
    await cache.saveThreads([{ summary: summary("t1", { subject: "new" }), replyMeta: null }]);
    expect(db.tables[MAIL_CACHE_TABLES.threads]).toHaveLength(1);
    expect((await cache.load([GMAIL.id])).threads[0].subject).toBe("new");
  });

  it("evicts the oldest summaries above the cap", async () => {
    const db = mailFakeDb();
    const cache = createDbMailCache(db, { logger: silent, maxThreads: 3 });
    await cache.saveThreads(page("t", 5).map((s) => ({ summary: s, replyMeta: null })));
    const ids = (await cache.load([GMAIL.id])).threads.map((s) => s.id);
    expect(ids).toEqual(["t0", "t1", "t2"]);
  });

  it("evicts the oldest rows across separate saves", async () => {
    const db = mailFakeDb();
    const cache = createDbMailCache(db, { logger: silent, maxThreads: 3 });
    await cache.saveThreads(page("t", 3, 2).map((s) => ({ summary: s, replyMeta: null })));
    await cache.saveThreads(page("t", 2).map((s) => ({ summary: s, replyMeta: null })));
    expect(db.tables[MAIL_CACHE_TABLES.threads].map((row) => (row.summary as { id: string }).id).sort()).toEqual(["t0", "t1", "t2"]);
  });

  it("loads only the given accounts and drops malformed rows", async () => {
    const db = mailFakeDb();
    db.tables[MAIL_CACHE_TABLES.threads] = [
      { id: "1", thread_key: "a", account_id: GMAIL.id, last_at: 1, summary: { id: "bad" } },
      { id: "2", thread_key: "b", account_id: OUTLOOK.id, last_at: 2, summary: summary("o", { accountId: OUTLOOK.id }) },
      { id: "3", thread_key: "c", account_id: GMAIL.id, last_at: 3, summary: JSON.stringify(summary("g")) },
    ];
    db.tables[MAIL_CACHE_TABLES.folders] = [{ id: "4", account_id: GMAIL.id, folders: [{ id: "x", name: "X", role: "nope" }, GMAIL_FOLDERS[0]] }];
    const loaded = await createDbMailCache(db, { logger: silent }).load([GMAIL.id]);
    expect(loaded.threads.map((s) => s.id)).toEqual(["g"]);
    expect(loaded.folders[GMAIL.id]).toEqual([GMAIL_FOLDERS[0]]);
  });

  it("clears snoozes set to null", async () => {
    const db = mailFakeDb();
    const cache = createDbMailCache(db, { logger: silent });
    const key = threadKey(GMAIL.id, "t1");
    await cache.saveSnoozes({ [key]: { accountId: GMAIL.id, until: "2026-11-20T08:00:00Z" } });
    await cache.saveSnoozes({ [key]: { accountId: GMAIL.id, until: null } });
    expect(db.tables[MAIL_CACHE_TABLES.snoozes]).toEqual([]);
  });

  it("logs and swallows write failures, and survives a failed read of one table", async () => {
    const db = mailFakeDb();
    const logger = vi.fn();
    const cache = createDbMailCache(db, { logger });
    db.failNext = "find";
    await expect(cache.saveThreads([{ summary: summary("t1"), replyMeta: null }])).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("cache.save.threads", expect.any(Error));
    await cache.saveFolders(GMAIL.id, GMAIL_FOLDERS);
    db.failNext = "find";
    const loaded = await cache.load([GMAIL.id]);
    expect(loaded.folders[GMAIL.id]).toEqual(GMAIL_FOLDERS);
    expect(await cache.load([])).toEqual({ folders: {}, threads: [], replyMeta: {}, snoozes: {} });
  });

  it("declares exactly the tables the app uses (cache and voice profiles) in the manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../../home/apps/mail/matrix.json"), "utf8"));
    const tables = manifest.storage.tables;
    expect(Object.keys(tables).sort()).toEqual([...Object.values(MAIL_CACHE_TABLES), VOICE_TABLE].sort());
    expect(tables[VOICE_TABLE].uniqueIndexes).toEqual(["profile_key"]);
    expect(tables.mail_threads.uniqueIndexes).toEqual(["thread_key"]);
    expect(tables.mail_folders.uniqueIndexes).toEqual(["account_id"]);
    expect(tables.mail_snoozes.uniqueIndexes).toEqual(["thread_key"]);
  });
});
