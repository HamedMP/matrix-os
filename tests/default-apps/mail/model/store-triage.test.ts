import { describe, expect, it } from "vitest";
import { createMailStore } from "../../../../home/apps/mail/src/model/store";
import { createDbMailCache, noMailCache } from "../../../../home/apps/mail/src/model/cache";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { isAllowedMailErrorMessage } from "../../../../home/apps/mail/src/model/errors";
import { ProviderError } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { GMAIL, GMAIL_FOLDERS, OUTLOOK, OUTLOOK_FOLDERS, summary } from "./fixtures";
import { FakeProvider, deferred } from "./fake-provider";
import { mailFakeDb } from "./fake-db";

const k = (id: string, accountId = GMAIL.id) => threadKey(accountId, id);
const quiet = () => undefined;
const NOW = Date.parse("2026-11-12T12:00:00Z");

async function setup(options: { outlook?: boolean; cache?: ReturnType<typeof createDbMailCache> } = {}) {
  const gmail = new FakeProvider(GMAIL_FOLDERS);
  const outlook = new FakeProvider(OUTLOOK_FOLDERS);
  gmail.pageSize = 10;
  gmail.lists.INBOX = [
    summary("t1", { lastMessageAt: "2026-11-10T12:00:00Z" }),
    summary("t2", { lastMessageAt: "2026-11-10T11:00:00Z" }),
    summary("t3", { lastMessageAt: "2026-11-10T10:00:00Z" }),
  ];
  outlook.lists["inbox-id"] = [summary("o1", { accountId: OUTLOOK.id, folderIds: ["inbox-id"], lastMessageAt: "2026-11-10T09:00:00Z" })];
  const accounts = [{ account: GMAIL, provider: gmail }, ...(options.outlook ? [{ account: OUTLOOK, provider: outlook }] : [])];
  const store = createMailStore({ accounts, cache: options.cache ?? noMailCache, logger: quiet, timeZone: "UTC", now: () => NOW });
  await store.start();
  return { store, gmail, outlook };
}

describe("optimistic triage", () => {
  it("archives at once, moves focus to the next row and records undo", async () => {
    const { store, gmail } = await setup();
    const pending = deferred<void>();
    gmail.onModify = () => pending.promise;
    store.focus(k("t1"));
    const archiving = store.archive();
    expect(store.visibleThreadKeys()).toEqual([k("t2"), k("t3")]);
    expect(store.getSnapshot().focused).toBe(k("t2"));
    expect(store.getSnapshot().pending).toHaveLength(1);
    pending.resolve();
    expect(await archiving).toBe(true);
    expect(gmail.calls.modifyThreads[0]).toEqual({ ids: ["t1"], change: { removeFolders: ["INBOX"] } });
    expect(store.getSnapshot().pending).toEqual([]);
    expect(store.getSnapshot().undo).toMatchObject({ kind: "archive", label: "Archived 1 conversation" });
  });

  it("rolls back and shows a safe error when the provider fails", async () => {
    const { store, gmail } = await setup();
    gmail.onModify = () => Promise.reject(new Error("HTTP 500 from googleapis.com for me@example.com"));
    store.focus(k("t1"));
    expect(await store.archive()).toBe(false);
    expect(store.visibleThreadKeys()).toEqual([k("t1"), k("t2"), k("t3")]);
    const error = store.getSnapshot().error!;
    expect(error).toMatchObject({ code: "failed", retryable: true });
    expect(isAllowedMailErrorMessage(error.message)).toBe(true);
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("undo sends the inverse change and brings the thread back", async () => {
    const { store, gmail } = await setup();
    store.focus(k("t2"));
    await store.archive();
    expect(await store.undo()).toBe(true);
    expect(gmail.calls.modifyThreads[1]).toEqual({ ids: ["t2"], change: { addFolders: ["INBOX"] } });
    expect(store.visibleThreadKeys()).toEqual([k("t1"), k("t2"), k("t3")]);
    expect(store.getSnapshot().undo).toBeNull();
    expect(await store.undo()).toBe(false);
  });

  it("bulk triage across accounts rolls back only the account that failed", async () => {
    const { store, outlook } = await setup({ outlook: true });
    outlook.onModify = () => Promise.reject(new ProviderError("rate_limited"));
    store.toggleSelect(k("t1"));
    store.toggleSelect(k("o1", OUTLOOK.id));
    expect(await store.markRead(false)).toBe(false);
    const state = store.getSnapshot();
    expect(state.threads[k("t1")].unread).toBe(true);
    expect(state.threads[k("o1", OUTLOOK.id)].unread).toBe(false);
    expect(state.error?.code).toBe("rate_limited");
    expect(state.undo?.changes).toEqual([{ key: k("t1"), change: { read: true } }]);
    expect(state.selection.keys).toEqual([]);
  });

  it("selects a range with shift and archives it in one call", async () => {
    const { store, gmail } = await setup();
    store.toggleSelect(k("t1"));
    store.selectRangeTo(k("t3"));
    await store.archive();
    expect(gmail.calls.modifyThreads).toEqual([{ ids: ["t1", "t2", "t3"], change: { removeFolders: ["INBOX"] } }]);
    expect(store.getSnapshot().undo?.label).toBe("Archived 3 conversations");
  });

  it("refuses a move that spans accounts and one with nothing selected", async () => {
    const { store, gmail } = await setup({ outlook: true });
    expect(await store.archive()).toBe(false);
    expect(store.getSnapshot().error?.code).toBe("nothing_selected");
    store.toggleSelect(k("t1"));
    store.toggleSelect(k("o1", OUTLOOK.id));
    expect(await store.moveTo("Label_1")).toBe(false);
    expect(store.getSnapshot().error?.code).toBe("mixed_accounts");
    expect(gmail.calls.modifyThreads).toEqual([]);
  });

  it("moves into a folder and flags", async () => {
    const { store, gmail } = await setup();
    await store.moveTo("Label_1", [k("t3")]);
    await store.setFlag(true, [k("t1")]);
    expect(gmail.calls.modifyThreads).toEqual([
      { ids: ["t3"], change: { addFolders: ["Label_1"], removeFolders: ["INBOX"] } },
      { ids: ["t1"], change: { flagged: true } },
    ]);
    expect(store.getSnapshot().threads[k("t1")].flagged).toBe(true);
  });
});

describe("snooze", () => {
  it("hides locally, persists and undoes without calling the provider", async () => {
    const db = mailFakeDb();
    const { store, gmail } = await setup({ cache: createDbMailCache(db, { logger: quiet }) });
    store.focus(k("t1"));
    expect(store.snooze("2026-11-13T08:00:00Z")).toBe(true);
    expect(store.visibleThreadKeys()).toEqual([k("t2"), k("t3")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.tables.mail_snoozes.map((row) => row.thread_key)).toEqual([k("t1")]);
    expect(await store.undo()).toBe(true);
    expect(store.visibleThreadKeys()).toEqual([k("t1"), k("t2"), k("t3")]);
    expect(gmail.calls.modifyThreads).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.tables.mail_snoozes).toEqual([]);
  });
});

describe("keyboard commands", () => {
  it("moves with j/k, selects with x, archives with e and asks the UI to focus search on /", async () => {
    const { store } = await setup();
    await store.runCommand("focusNext");
    await store.runCommand("focusNext");
    expect(store.getSnapshot().focused).toBe(k("t2"));
    await store.runCommand("focusPrevious");
    expect(store.getSnapshot().focused).toBe(k("t1"));
    await store.runCommand("toggleSelect");
    await store.runCommand("extendNext");
    expect(store.getSnapshot().selection.keys).toEqual([k("t1"), k("t2")]);
    await store.runCommand("archive");
    expect(store.visibleThreadKeys()).toEqual([k("t3")]);
    expect(await store.runCommand("search")).toEqual({ handled: true, effect: "focusSearch" });
    expect(await store.runCommand("compose")).toEqual({ handled: true, effect: "showComposer" });
  });

  it("toggles the flag on the focused thread", async () => {
    const { store } = await setup();
    store.focus(k("t1"));
    await store.runCommand("toggleFlag");
    expect(store.getSnapshot().threads[k("t1")].flagged).toBe(true);
    await store.runCommand("toggleFlag");
    expect(store.getSnapshot().threads[k("t1")].flagged).toBe(false);
  });
});
