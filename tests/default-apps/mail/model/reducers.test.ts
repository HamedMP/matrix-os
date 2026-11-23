import { describe, expect, it } from "vitest";
import { UNIFIED_INBOX, threadKey, viewKeyOf } from "../../../../home/apps/mail/src/model/ids";
import {
  applyCache,
  applyListing,
  applyOptimistic,
  commitPending,
  ensureView,
  focusAfterRemoval,
  initialMailState,
  moveFocus,
  pruneThreads,
  pruneViews,
  rollbackPending,
  selectRange,
  setFolders,
  toggleSelected,
  wakeDueSnoozes,
  setSnoozes,
} from "../../../../home/apps/mail/src/model/reducers";
import type { MailState, PendingTriage } from "../../../../home/apps/mail/src/model/types";
import { GMAIL, GMAIL_FOLDERS, OUTLOOK, OUTLOOK_FOLDERS, page, summary } from "./fixtures";

const INBOX_KEY = viewKeyOf(UNIFIED_INBOX);

function ready(): MailState {
  let state = initialMailState([GMAIL, OUTLOOK]);
  state = setFolders(state, GMAIL.id, GMAIL_FOLDERS);
  state = setFolders(state, OUTLOOK.id, OUTLOOK_FOLDERS);
  return state;
}

const k = (id: string, accountId = GMAIL.id) => threadKey(accountId, id);

describe("applyListing", () => {
  it("merges accounts newest first in the unified inbox", () => {
    const state = applyListing(ready(), INBOX_KEY, [
      { accountId: GMAIL.id, items: [summary("g1", { lastMessageAt: "2026-11-10T08:00:00Z" })], nextCursor: "c1" },
      { accountId: OUTLOOK.id, items: [summary("o1", { accountId: OUTLOOK.id, folderIds: ["inbox-id"], lastMessageAt: "2026-11-10T09:00:00Z" })], nextCursor: null },
    ], "replace", 1);
    expect(state.views[INBOX_KEY].threadKeys).toEqual([k("o1", OUTLOOK.id), k("g1")]);
    expect(state.views[INBOX_KEY].cursors).toEqual({ [GMAIL.id]: "c1", [OUTLOOK.id]: null });
    expect(state.views[INBOX_KEY].status).toBe("ready");
  });

  it("replacing one account keeps the other account's rows", () => {
    let state = applyListing(ready(), INBOX_KEY, [
      { accountId: GMAIL.id, items: [summary("g1")], nextCursor: null },
      { accountId: OUTLOOK.id, items: [summary("o1", { accountId: OUTLOOK.id, folderIds: ["inbox-id"] })], nextCursor: null },
    ], "replace", 1);
    state = applyListing(state, INBOX_KEY, [{ accountId: GMAIL.id, items: [summary("g2")], nextCursor: null }], "replace", 2);
    expect(state.views[INBOX_KEY].threadKeys.sort()).toEqual([k("g2"), k("o1", OUTLOOK.id)].sort());
  });

  it("appends a further page without duplicates and ignores rows from another account", () => {
    let state = applyListing(ready(), INBOX_KEY, [{ accountId: GMAIL.id, items: page("t", 3), nextCursor: "next" }], "replace", 1);
    state = applyListing(state, INBOX_KEY, [{
      accountId: GMAIL.id,
      items: [...page("t", 3, 2), summary("x", { accountId: OUTLOOK.id })],
      nextCursor: null,
    }], "append", 2);
    expect(state.views[INBOX_KEY].threadKeys).toEqual(["t0", "t1", "t2", "t3", "t4"].map((id) => k(id)));
    expect(state.threads[k("x", OUTLOOK.id)]).toBeUndefined();
  });

  it("re-applies in-flight optimistic changes to fresh provider rows", () => {
    let state = applyListing(ready(), INBOX_KEY, [{ accountId: GMAIL.id, items: [summary("t1", { unread: true })], nextCursor: null }], "replace", 1);
    const op: PendingTriage = { id: "op", kind: "markRead", changes: [{ key: k("t1"), change: { read: true } }], before: { [k("t1")]: state.threads[k("t1")] } };
    state = applyOptimistic(state, op);
    state = applyListing(state, INBOX_KEY, [{ accountId: GMAIL.id, items: [summary("t1", { unread: true })], nextCursor: null }], "replace", 2);
    expect(state.threads[k("t1")].unread).toBe(false);
  });
});

describe("optimistic triage", () => {
  function withRows(): MailState {
    return applyListing(ready(), INBOX_KEY, [{ accountId: GMAIL.id, items: page("t", 3), nextCursor: null }], "replace", 1);
  }

  it("removes archived threads from the inbox and puts them back on rollback", () => {
    const state = withRows();
    const op: PendingTriage = {
      id: "op1",
      kind: "archive",
      changes: [{ key: k("t1"), change: { removeFolders: ["INBOX"] } }],
      before: { [k("t1")]: state.threads[k("t1")] },
    };
    const applied = applyOptimistic(state, op);
    expect(applied.views[INBOX_KEY].threadKeys).toEqual([k("t0"), k("t2")]);
    expect(applied.pending).toHaveLength(1);
    const rolled = rollbackPending(applied, "op1");
    expect(rolled.views[INBOX_KEY].threadKeys).toEqual([k("t0"), k("t1"), k("t2")]);
    expect(rolled.threads[k("t1")].folderIds).toEqual(["INBOX"]);
    expect(rolled.pending).toHaveLength(0);
    expect(state.views[INBOX_KEY].threadKeys).toHaveLength(3);
  });

  it("rollback keeps a later change to another field", () => {
    let state = withRows();
    const archive: PendingTriage = { id: "a", kind: "archive", changes: [{ key: k("t0"), change: { removeFolders: ["INBOX"] } }], before: { [k("t0")]: state.threads[k("t0")] } };
    state = applyOptimistic(state, archive);
    const flag: PendingTriage = { id: "f", kind: "flag", changes: [{ key: k("t0"), change: { flagged: true } }], before: { [k("t0")]: state.threads[k("t0")] } };
    state = commitPending(applyOptimistic(state, flag), "f");
    state = rollbackPending(state, "a");
    expect(state.threads[k("t0")]).toMatchObject({ folderIds: ["INBOX"], flagged: true });
  });

  it("adds a moved thread to the target folder list", () => {
    let state = ensureView(withRows(), { kind: "folder", accountId: GMAIL.id, folderId: "Label_1" });
    const folderKey = viewKeyOf({ kind: "folder", accountId: GMAIL.id, folderId: "Label_1" });
    const op: PendingTriage = { id: "m", kind: "move", changes: [{ key: k("t2"), change: { addFolders: ["Label_1"], removeFolders: ["INBOX"] } }], before: { [k("t2")]: state.threads[k("t2")] } };
    state = applyOptimistic(state, op);
    expect(state.views[folderKey].threadKeys).toEqual([k("t2")]);
    expect(state.views[INBOX_KEY].threadKeys).not.toContain(k("t2"));
  });
});

describe("selection and focus", () => {
  const visible = ["a", "b", "c", "d", "e"];

  it("selects a range from the anchor", () => {
    let state = toggleSelected(initialMailState(), "b");
    state = selectRange(state, "d", visible);
    expect(state.selection.keys).toEqual(["b", "c", "d"]);
    expect(state.focused).toBe("d");
  });

  it("extends the selection while moving focus with shift", () => {
    let state = moveFocus(initialMailState(), 1, visible);
    expect(state.focused).toBe("a");
    state = moveFocus(state, 1, visible, true);
    state = moveFocus(state, 1, visible, true);
    expect(state.selection.keys).toEqual(["a", "b", "c"]);
    expect(state.focused).toBe("c");
  });

  it("clamps focus at the ends", () => {
    const state = moveFocus({ ...initialMailState(), focused: "e" }, 1, visible);
    expect(state.focused).toBe("e");
  });

  it("focuses the next remaining row after removal, else the previous", () => {
    expect(focusAfterRemoval(visible, ["b", "c"], "b")).toBe("d");
    expect(focusAfterRemoval(visible, ["e"], "e")).toBe("d");
    expect(focusAfterRemoval(visible, ["a"], "c")).toBe("c");
    expect(focusAfterRemoval(["a"], ["a"], "a")).toBeNull();
  });
});

describe("eviction", () => {
  it("drops the oldest unreferenced summaries first", () => {
    let state = applyListing(ready(), INBOX_KEY, [{ accountId: GMAIL.id, items: page("t", 2), nextCursor: null }], "replace", 1);
    const extra = page("old", 4, 10, { folderIds: ["Label_9"] });
    state = { ...state, threads: { ...state.threads, ...Object.fromEntries(extra.map((s) => [k(s.id), s])) } };
    const pruned = pruneThreads(state, 3);
    expect(Object.keys(pruned.threads).sort()).toEqual([k("old10"), k("t0"), k("t1")].sort());
  });

  it("keeps summaries a list still shows even above the cap", () => {
    const state = applyListing(ready(), INBOX_KEY, [{ accountId: GMAIL.id, items: page("t", 5), nextCursor: null }], "replace", 1);
    expect(Object.keys(pruneThreads(state, 2).threads)).toHaveLength(5);
  });

  it("drops the least recently opened search lists but never the active one", () => {
    let state = initialMailState([GMAIL]);
    for (let i = 0; i < 5; i += 1) {
      const descriptor = { kind: "search" as const, query: `q${i}` };
      state = ensureView(state, descriptor);
      const key = viewKeyOf(descriptor);
      state = { ...state, views: { ...state.views, [key]: { ...state.views[key], openedAt: i } }, activeView: key };
    }
    state = { ...state, activeView: viewKeyOf({ kind: "search", query: "q0" }) };
    const pruned = pruneViews(state, 3);
    expect(Object.values(pruned.views).map((v) => v.descriptor)).toEqual([
      UNIFIED_INBOX,
      { kind: "search", query: "q0" },
      { kind: "search", query: "q4" },
    ]);
  });
});

describe("cache and snoozes", () => {
  it("paints cached rows without overwriting fresher ones", () => {
    let state = applyListing(ready(), INBOX_KEY, [{ accountId: GMAIL.id, items: [summary("t1", { subject: "fresh" })], nextCursor: null }], "replace", 1);
    state = applyCache(state, {
      folders: { [GMAIL.id]: [] },
      threads: [summary("t1", { subject: "stale" }), summary("t2"), summary("z", { accountId: "gmail:gone@example.com" })],
      replyMeta: {},
      snoozes: {},
    });
    expect(state.threads[k("t1")].subject).toBe("fresh");
    expect(state.threads[k("t2")]).toBeDefined();
    expect(state.threads[threadKey("gmail:gone@example.com", "z")]).toBeUndefined();
    expect(state.folders[GMAIL.id]).toBe(GMAIL_FOLDERS);
    expect(state.cacheLoaded).toBe(true);
  });

  it("builds a list from cache before the first listing", () => {
    const state = applyCache(initialMailState([GMAIL]), {
      folders: { [GMAIL.id]: GMAIL_FOLDERS },
      threads: page("t", 2),
      replyMeta: {},
      snoozes: {},
    });
    expect(state.views[INBOX_KEY]).toMatchObject({ threadKeys: [k("t0"), k("t1")], fromCache: true });
  });

  it("wakes only the snoozes that are due", () => {
    let state = setSnoozes(initialMailState(), { a: "2026-11-10T09:00:00Z", b: "2026-11-12T09:00:00Z" });
    state = wakeDueSnoozes(state, Date.parse("2026-11-11T00:00:00Z"));
    expect(state.snoozed).toEqual({ b: "2026-11-12T09:00:00Z" });
    expect(wakeDueSnoozes(state, Date.parse("2026-11-11T00:00:00Z"))).toBe(state);
  });
});
