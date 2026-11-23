import { describe, expect, it, vi } from "vitest";
import { createMailStore } from "../../../../home/apps/mail/src/model/store";
import { createDbMailCache, noMailCache } from "../../../../home/apps/mail/src/model/cache";
import { UNIFIED_INBOX, threadKey, viewKeyOf } from "../../../../home/apps/mail/src/model/ids";
import { isAllowedMailErrorMessage } from "../../../../home/apps/mail/src/model/errors";
import { selectHasMore } from "../../../../home/apps/mail/src/model/selectors";
import type { Page, ThreadSummary } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { GMAIL, GMAIL_FOLDERS, OUTLOOK, OUTLOOK_FOLDERS, message, page, summary, thread } from "./fixtures";
import { FakeProvider, deferred } from "./fake-provider";
import { mailFakeDb } from "./fake-db";

const INBOX = viewKeyOf(UNIFIED_INBOX);
const k = (id: string, accountId = GMAIL.id) => threadKey(accountId, id);
const quiet = () => undefined;

function setup(options: { outlook?: boolean } = {}) {
  const gmail = new FakeProvider(GMAIL_FOLDERS);
  const outlook = new FakeProvider(OUTLOOK_FOLDERS);
  const accounts = [{ account: GMAIL, provider: gmail }, ...(options.outlook ? [{ account: OUTLOOK, provider: outlook }] : [])];
  const store = createMailStore({ accounts, cache: noMailCache, logger: quiet, timeZone: "UTC", now: () => Date.parse("2026-11-12T12:00:00Z") });
  return { store, gmail, outlook };
}

describe("lists", () => {
  it("paints the cache first, then replaces it with the provider listing", async () => {
    const db = mailFakeDb();
    const cache = createDbMailCache(db, { logger: quiet });
    await cache.saveFolders(GMAIL.id, GMAIL_FOLDERS);
    await cache.saveThreads([{ summary: summary("cached"), replyMeta: null }]);
    const gmail = new FakeProvider(GMAIL_FOLDERS);
    const listing = deferred<Page<ThreadSummary>>();
    gmail.onListThreads = () => listing.promise;
    const store = createMailStore({ accounts: [{ account: GMAIL, provider: gmail }], cache, logger: quiet, timeZone: "UTC" });
    const started = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().cacheLoaded).toBe(true));
    expect(store.visibleThreadKeys()).toEqual([k("cached")]);
    expect(store.getSnapshot().views[INBOX].fromCache).toBe(true);
    listing.resolve({ items: [summary("fresh")], nextCursor: null });
    await started;
    expect(store.visibleThreadKeys()).toEqual([k("fresh")]);
    expect(store.getSnapshot().views[INBOX]).toMatchObject({ status: "ready", fromCache: false });
    await store.dispose();
    expect(db.tables.mail_threads.map((row) => (row.summary as ThreadSummary).id).sort()).toEqual(["cached", "fresh"]);
  });

  it("pages with the provider cursor until there are no more pages", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = page("t", 5);
    await store.start();
    expect(store.visibleThreadKeys()).toEqual([k("t0"), k("t1")]);
    expect(selectHasMore(store.getSnapshot())).toBe(true);
    await store.loadMore();
    await store.loadMore();
    expect(store.visibleThreadKeys()).toEqual(["t0", "t1", "t2", "t3", "t4"].map((id) => k(id)));
    expect(gmail.calls.listThreads.map((call) => call.cursor)).toEqual([undefined, "2", "4"]);
    expect(selectHasMore(store.getSnapshot())).toBe(false);
    await store.loadMore();
    expect(gmail.calls.listThreads).toHaveLength(3);
  });

  it("drops a slow answer for a list that was refreshed since", async () => {
    const { store, gmail } = setup();
    const first = deferred<Page<ThreadSummary>>();
    const second = deferred<Page<ThreadSummary>>();
    const answers = [first, second];
    gmail.onListThreads = () => answers.shift()!.promise;
    await store.loadFolders(GMAIL.id);
    const a = store.refresh();
    const b = store.refresh();
    second.resolve({ items: [summary("new")], nextCursor: null });
    await b;
    first.resolve({ items: [summary("old")], nextCursor: null });
    await a;
    expect(store.visibleThreadKeys()).toEqual([k("new")]);
  });

  it("keeps one account's rows when the other fails, with a safe error", async () => {
    const { store, gmail, outlook } = setup({ outlook: true });
    gmail.lists.INBOX = [summary("g1")];
    outlook.onListThreads = () => Promise.reject(new Error("token abc123 rejected by upstream host"));
    await store.start();
    const view = store.getSnapshot().views[INBOX];
    expect(view.threadKeys).toEqual([k("g1")]);
    expect(view.status).toBe("ready");
    expect(view.error?.code).toBe("failed");
    expect(isAllowedMailErrorMessage(view.error!.message)).toBe(true);
    expect(view.error!.message).not.toContain("token");
  });

  it("opens a folder of one account", async () => {
    const { store, gmail } = setup();
    gmail.lists.Label_1 = [summary("p1", { folderIds: ["Label_1"] })];
    await store.start();
    await store.openView({ kind: "folder", accountId: GMAIL.id, folderId: "Label_1" });
    expect(store.visibleThreadKeys()).toEqual([k("p1")]);
    expect(gmail.calls.listThreads.at(-1)).toMatchObject({ folderId: "Label_1", limit: 25 });
  });
});

describe("search", () => {
  it("shows cached matches at once, then the provider results, with the query translated", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = [summary("a", { subject: "Budget" }), summary("b", { subject: "Lunch" })];
    await store.start();
    const results = deferred<Page<ThreadSummary>>();
    gmail.search = async (query: string) => {
      gmail.calls.search.push({ query });
      return results.promise;
    };
    const searching = store.search("subject:budget is:unread");
    await vi.waitFor(() => expect(store.getSnapshot().views[store.getSnapshot().activeView].descriptor.kind).toBe("search"));
    expect(store.visibleThreadKeys()).toEqual([]);
    results.resolve({ items: [summary("c", { subject: "Budget 2027", unread: true, folderIds: ["Label_1"] })], nextCursor: null });
    await searching;
    expect(gmail.calls.search[0].query).toBe("subject:budget is:unread");
    expect(store.visibleThreadKeys()).toEqual([k("c")]);
  });

  it("paints local matches before the provider answers", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = [summary("a", { subject: "Budget" }), summary("b", { subject: "Lunch" })];
    await store.start();
    const results = deferred<Page<ThreadSummary>>();
    gmail.search = () => results.promise;
    const searching = store.search("budget");
    await vi.waitFor(() => expect(store.visibleThreadKeys()).toEqual([k("a")]));
    results.resolve({ items: [], nextCursor: null });
    await searching;
  });

  it("filters the active list locally without calling the provider", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = [summary("a", { unread: true }), summary("b")];
    await store.start();
    store.setFilter("is:unread");
    expect(store.visibleThreadKeys()).toEqual([k("a")]);
    expect(gmail.calls.search).toHaveLength(0);
  });

  it("an empty search returns to the inbox", async () => {
    const { store } = setup();
    await store.start();
    await store.search("   ");
    expect(store.getSnapshot().activeView).toBe(INBOX);
  });
});

describe("open thread", () => {
  it("loads bodies, learns who wrote last and marks the thread read", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = [summary("t1", { unread: true })];
    gmail.threads.t1 = thread("t1", [message("m1", { from: { address: "alice@example.com" } })]);
    await store.start();
    await store.openThread(k("t1"));
    const state = store.getSnapshot();
    expect(state.openThread).toMatchObject({ key: k("t1"), status: "ready" });
    expect(state.openThread?.thread?.messages).toHaveLength(1);
    expect(state.replyMeta[k("t1")]).toMatchObject({ ownerSentLast: false });
    await vi.waitFor(() => expect(gmail.calls.modifyThreads).toEqual([{ ids: ["t1"], change: { read: true } }]));
    expect(store.getSnapshot().threads[k("t1")].unread).toBe(false);
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("ignores a late answer for a thread the owner left", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = [summary("t1"), summary("t2")];
    const slow = deferred<ReturnType<typeof thread>>();
    gmail.onGetThread = (id) => (id === "t1" ? slow.promise : Promise.resolve(thread("t2", [message("m2")])));
    await store.start();
    const first = store.openThread(k("t1"));
    await store.openThread(k("t2"));
    slow.resolve(thread("t1", [message("m1")]));
    await first;
    expect(store.getSnapshot().openThread).toMatchObject({ key: k("t2"), status: "ready" });
  });

  it("surfaces a generic error when the thread cannot be loaded", async () => {
    const { store, gmail } = setup();
    gmail.lists.INBOX = [summary("t1")];
    await store.start();
    await store.openThread(k("t1"));
    const open = store.getSnapshot().openThread!;
    expect(open.status).toBe("error");
    expect(open.error?.message).not.toContain("/internal/path");
  });
});
