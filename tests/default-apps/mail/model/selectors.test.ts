import { describe, expect, it } from "vitest";
import { UNIFIED_INBOX, threadKey, viewKeyOf } from "../../../../home/apps/mail/src/model/ids";
import { applyListing, initialMailState, setFolders, setSnoozes } from "../../../../home/apps/mail/src/model/reducers";
import {
  selectAwaitingThem,
  selectFolderTree,
  selectInboxUnread,
  selectTargetKeys,
  selectVisibleThreadKeys,
  selectWaitingOnYou,
  waitingState,
} from "../../../../home/apps/mail/src/model/selectors";
import type { MailState } from "../../../../home/apps/mail/src/model/types";
import { GMAIL, GMAIL_FOLDERS, summary } from "./fixtures";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const INBOX_KEY = viewKeyOf(UNIFIED_INBOX);
const k = (id: string) => threadKey(GMAIL.id, id);

function withInbox(items = [
  summary("t1", { subject: "Budget plan", unread: true, lastMessageAt: "2026-11-11T09:00:00Z" }),
  summary("t2", { participants: [{ name: "Bob", address: "bob@example.com" }], hasAttachments: true, lastMessageAt: "2026-11-10T09:00:00Z" }),
  summary("t3", { snippet: "the quarterly numbers", lastMessageAt: "2026-11-01T09:00:00Z" }),
]): MailState {
  const state = setFolders(initialMailState([GMAIL]), GMAIL.id, GMAIL_FOLDERS);
  return applyListing(state, INBOX_KEY, [{ accountId: GMAIL.id, items, nextCursor: null }], "replace", 1);
}

describe("selectVisibleThreadKeys", () => {
  it("applies the instant filter language", () => {
    const state = withInbox();
    const visible = (filter: string) => selectVisibleThreadKeys({ ...state, filter }, NOW);
    expect(visible("")).toEqual([k("t1"), k("t2"), k("t3")]);
    expect(visible("is:unread")).toEqual([k("t1")]);
    expect(visible("from:bob has:attachment")).toEqual([k("t2")]);
    expect(visible("quarterly")).toEqual([k("t3")]);
    expect(visible("subject:budget")).toEqual([k("t1")]);
    expect(visible("after:2026-11-02 before:2026-11-11")).toEqual([k("t2")]);
  });

  it("hides snoozed threads from the inbox until they wake", () => {
    let state = setSnoozes(withInbox(), { [k("t1")]: "2026-11-13T08:00:00Z", [k("t2")]: "2026-11-12T08:00:00Z" });
    expect(selectVisibleThreadKeys(state, NOW)).toEqual([k("t2"), k("t3")]);
    state = { ...state };
    expect(selectVisibleThreadKeys(state, Date.parse("2026-11-13T09:00:00Z"))).toEqual([k("t1"), k("t2"), k("t3")]);
  });

  it("returns the same array while nothing changes", () => {
    const state = withInbox();
    expect(selectVisibleThreadKeys(state, NOW)).toBe(selectVisibleThreadKeys(state, NOW + 1000));
  });
});

describe("selectTargetKeys", () => {
  it("prefers the selection over the focused row", () => {
    const state = withInbox();
    expect(selectTargetKeys({ ...state, focused: k("t1") })).toEqual([k("t1")]);
    expect(selectTargetKeys({ ...state, focused: k("t1"), selection: { keys: [k("t2"), k("t3")], anchor: null } })).toEqual([k("t2"), k("t3")]);
    expect(selectTargetKeys(state)).toEqual([]);
  });
});

describe("waiting lists", () => {
  it("uses the folders when no reply data is known", () => {
    expect(waitingState(summary("a", { folderIds: ["INBOX"] }), undefined, GMAIL_FOLDERS)).toBe("you");
    expect(waitingState(summary("a", { folderIds: ["SENT"] }), undefined, GMAIL_FOLDERS)).toBe("them");
    expect(waitingState(summary("a", { folderIds: ["INBOX", "SENT"] }), undefined, GMAIL_FOLDERS)).toBeNull();
    expect(waitingState(summary("a", { folderIds: ["INBOX", "TRASH"] }), undefined, GMAIL_FOLDERS)).toBeNull();
  });

  it("trusts fresh reply data and ignores stale reply data", () => {
    const s = summary("a", { folderIds: ["INBOX", "SENT"], lastMessageAt: "2026-11-10T09:00:00Z" });
    expect(waitingState(s, { lastFrom: "me@example.com", lastAt: "2026-11-10T10:00:00+01:00", ownerSentLast: true }, GMAIL_FOLDERS)).toBe("them");
    expect(waitingState(s, { lastFrom: "alice@example.com", lastAt: "2026-11-10T09:00:00Z", ownerSentLast: false }, GMAIL_FOLDERS)).toBe("you");
    expect(waitingState(s, { lastFrom: "me@example.com", lastAt: "2026-11-09T09:00:00Z", ownerSentLast: true }, GMAIL_FOLDERS)).toBeNull();
  });

  it("lists recent threads newest first and drops old and snoozed ones", () => {
    let state = withInbox([
      summary("in1", { lastMessageAt: "2026-11-11T09:00:00Z" }),
      summary("in2", { lastMessageAt: "2026-11-11T10:00:00Z" }),
      summary("old", { lastMessageAt: "2026-09-01T09:00:00Z" }),
    ]);
    state = { ...state, threads: { ...state.threads, [k("s1")]: summary("s1", { folderIds: ["SENT"], lastMessageAt: "2026-11-11T09:00:00Z" }) } };
    expect(selectWaitingOnYou(state, NOW)).toEqual([k("in2"), k("in1")]);
    expect(selectAwaitingThem(state, NOW)).toEqual([k("s1")]);
    state = setSnoozes(state, { [k("in2")]: "2026-11-20T00:00:00Z" });
    expect(selectWaitingOnYou(state, NOW)).toEqual([k("in1")]);
  });
});

describe("folders", () => {
  it("builds a tree with system folders first", () => {
    const tree = selectFolderTree(GMAIL_FOLDERS);
    expect(tree.map((node) => node.folder.id)).toEqual(["INBOX", "STARRED", "DRAFT", "SENT", "ARCHIVE", "SPAM", "TRASH", "Label_1"]);
    expect(tree[7].children.map((node) => [node.folder.id, node.depth])).toEqual([["Label_2", 1]]);
  });

  it("survives parent cycles and missing parents", () => {
    const tree = selectFolderTree([
      { id: "a", name: "A", role: "custom", parentId: "b" },
      { id: "b", name: "B", role: "custom", parentId: "a" },
      { id: "c", name: "C", role: "custom", parentId: "missing" },
    ]);
    expect(tree.map((node) => node.folder.id)).toEqual(["c"]);
  });

  it("reports inbox unread counts per account", () => {
    expect(selectInboxUnread(withInbox())).toEqual({ [GMAIL.id]: 2 });
  });
});
