import { describe, expect, it } from "vitest";
import { createGmailProvider } from "../../../../home/apps/_shared/office-accounts/mail/gmail-provider";
import { GMAIL_ARCHIVE_ID, GMAIL_ARCHIVE_QUERY } from "../../../../home/apps/_shared/office-accounts/mail/gmail-normalize";
import { ProviderError, mailAccountId, type MailAccount } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { FakeBridge, statusError } from "./fake-bridge";
import {
  GMAIL_DRAFT_LIST, GMAIL_INBOX_LABEL, GMAIL_LABELS, GMAIL_MESSAGE_A1_FULL, GMAIL_MESSAGE_A2_FULL, GMAIL_MESSAGE_A3_DRAFT,
  GMAIL_THREAD_A_FULL, GMAIL_THREAD_A_SUMMARY, GMAIL_THREAD_B_SUMMARY, GMAIL_THREAD_C_SUMMARY, GMAIL_THREAD_LIST_LAST,
  GMAIL_THREAD_LIST_PAGE_1,
} from "./gmail-fixtures";

const ACCOUNT: MailAccount = { id: mailAccountId("gmail", "owner@example.com"), provider: "gmail", address: "owner@example.com", displayName: "Owner" };

function setup(label: string | null = "owner@example.com") {
  const bridge = new FakeBridge();
  const provider = createGmailProvider({ account: ACCOUNT, label: label ?? undefined, bridge });
  return { bridge, provider };
}

describe("gmail listFolders", () => {
  it("maps system labels to roles, adds a virtual archive and nests user labels by slash", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "list_labels", GMAIL_LABELS).reply("gmail", "get_label", GMAIL_INBOX_LABEL);
    const folders = await provider.listFolders();

    expect(bridge.calls.map(({ service, action, params, label }) => ({ service, action, params, label }))).toEqual([
      { service: "gmail", action: "list_labels", params: {}, label: "owner@example.com" },
      { service: "gmail", action: "get_label", params: { labelId: "INBOX" }, label: "owner@example.com" },
    ]);
    expect(folders).toEqual([
      { id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 7 },
      { id: "STARRED", name: "Starred", role: "starred" },
      { id: "SENT", name: "Sent", role: "sent" },
      { id: "DRAFT", name: "Drafts", role: "drafts" },
      { id: GMAIL_ARCHIVE_ID, name: "Archive", role: "archive", virtual: true },
      { id: "SPAM", name: "Spam", role: "spam" },
      { id: "TRASH", name: "Trash", role: "trash" },
      { id: "Label_11", name: "Projects", role: "custom" },
      { id: "Label_12", name: "Alpha", role: "custom", parentId: "Label_11" },
      { id: "Label_30", name: "Receipts", role: "custom", unreadCount: 2 },
    ]);
  });

  it("keeps the folder list when the inbox count cannot be read", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "list_labels", GMAIL_LABELS).fail("gmail", "get_label", statusError(502));
    const folders = await provider.listFolders();
    expect(folders.find((folder) => folder.role === "inbox")).toEqual({ id: "INBOX", name: "Inbox", role: "inbox" });
  });

  it("shares one request between identical reads in flight", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "list_labels", GMAIL_LABELS).reply("gmail", "get_label", GMAIL_INBOX_LABEL);
    const [first, second] = await Promise.all([provider.listFolders(), provider.listFolders()]);
    expect(second).toEqual(first);
    expect(bridge.callsTo("list_labels")).toHaveLength(1);
    expect(bridge.callsTo("get_label")).toHaveLength(1);
  });
});

describe("gmail listThreads and search", () => {
  it("lists a label page, summarises each thread and returns newest first with a cursor", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "list_threads_query", GMAIL_THREAD_LIST_PAGE_1)
      .reply("gmail", "get_thread", GMAIL_THREAD_A_SUMMARY, GMAIL_THREAD_B_SUMMARY);
    const page = await provider.listThreads({ folderId: "INBOX", limit: 25 });

    expect(bridge.callsTo("list_threads_query")[0].params).toEqual({ labelIds: ["INBOX"], maxResults: 25 });
    expect(bridge.callsTo("get_thread").map((call) => call.params)).toEqual([
      { threadId: "18c1a", format: "summary" },
      { threadId: "18c2b", format: "summary" },
    ]);
    expect(page.items.map((item) => item.id)).toEqual(["18c2b", "18c1a"]);
    expect(page.items[1]).toEqual({
      id: "18c1a",
      accountId: ACCOUNT.id,
      subject: "Review – Q3",
      snippet: "Thursday works & I'll book a room",
      participants: [
        { name: "Lovelace, Ada", address: "ada@example.com" },
        { name: "Bob Stone", address: "bob@example.com" },
        { name: "Owner", address: "owner@example.com" },
      ],
      lastMessageAt: "2025-11-23T11:00:00Z",
      unread: true,
      flagged: true,
      hasAttachments: true,
      folderIds: ["INBOX", "STARRED", "Label_12"],
      messageCount: 2,
    });
    // An inline image is not a listed attachment.
    expect(page.items[0].hasAttachments).toBe(false);
    expect(page.nextCursor).toBe("g.09876543210");

    bridge.reply("gmail", "list_threads_query", GMAIL_THREAD_LIST_LAST).reply("gmail", "get_thread", GMAIL_THREAD_C_SUMMARY);
    const next = await provider.listThreads({ folderId: "INBOX", limit: 500, cursor: page.nextCursor ?? undefined, query: " from:billing " });
    expect(bridge.callsTo("list_threads_query")[1].params).toEqual({
      labelIds: ["INBOX"], query: "from:billing", maxResults: 50, pageToken: "09876543210",
    });
    expect(next.nextCursor).toBeNull();
    expect(next.items[0].folderIds).toEqual(["Label_30"]);
  });

  it("lists the virtual archive with a search instead of a label", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "list_threads_query", { resultSizeEstimate: 0 }, { resultSizeEstimate: 0 });
    await provider.listThreads({ folderId: GMAIL_ARCHIVE_ID, limit: 10 });
    await provider.listThreads({ folderId: GMAIL_ARCHIVE_ID, limit: 10, query: "invoice" });
    expect(bridge.callsTo("list_threads_query").map((call) => call.params)).toEqual([
      { query: GMAIL_ARCHIVE_QUERY, maxResults: 10 },
      { query: `${GMAIL_ARCHIVE_QUERY} invoice`, maxResults: 10 },
    ]);
  });

  it("rejects a foreign cursor and a malformed folder id without calling the provider", async () => {
    const { bridge, provider } = setup();
    await expect(provider.listThreads({ folderId: "INBOX", limit: 5, cursor: "o.25" })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.listThreads({ folderId: "../labels", limit: 5 })).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toHaveLength(0);
  });

  it("searches across folders and returns nothing for an empty query", async () => {
    const { bridge, provider } = setup();
    expect(await provider.search("   ")).toEqual({ items: [], nextCursor: null });
    bridge.reply("gmail", "list_threads_query", GMAIL_THREAD_LIST_LAST).reply("gmail", "get_thread", GMAIL_THREAD_C_SUMMARY);
    const page = await provider.search("has:attachment receipt");
    expect(bridge.callsTo("list_threads_query")[0].params).toEqual({ query: "has:attachment receipt", maxResults: 25 });
    expect(page.items.map((item) => item.subject)).toEqual(["Receipt"]);
  });
});

describe("gmail getThread", () => {
  it("normalises every message, oldest first, with bodies, headers, attachments and draft ids", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "get_thread", GMAIL_THREAD_A_FULL).reply("gmail", "list_drafts", GMAIL_DRAFT_LIST);
    const thread = await provider.getThread("18c1a");

    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["get_thread", { threadId: "18c1a", format: "full" }],
      ["list_drafts", { maxResults: 100 }],
    ]);
    expect(thread.id).toBe("18c1a");
    expect(thread.subject).toBe("Review – Q3");
    expect(thread.folderIds).toEqual(["DRAFT", "INBOX", "STARRED", "Label_12"]);
    expect(thread.messages.map((message) => message.id)).toEqual(["m-a1", "m-a2", "m-a3"]);

    const [first, second, draft] = thread.messages;
    expect(first).toEqual({
      id: "m-a1",
      threadId: "18c1a",
      from: { name: "Lovelace, Ada", address: "ada@example.com" },
      to: [{ name: "Owner", address: "owner@example.com" }, { name: "Bob Stone", address: "bob@example.com" }],
      cc: [{ address: "carol@example.com" }, { address: "dan@example.com" }],
      bcc: [],
      sentAt: "2025-11-23T10:00:00Z",
      subject: "Review – Q3",
      bodyText: "Hi team,\nCan we move the review to Thursday?\n— Ada",
      bodyHtml: expect.stringContaining("<script>alert(1)</script>"),
      attachments: [{ id: "ANGjdJ8", name: "agenda.pdf", mimeType: "application/pdf", size: 20480 }],
      messageIdHeader: "<CAF-a1@mail.example.com>",
      references: ["<root@mail.example.com>", "<mid@mail.example.com>"],
      unread: false,
    });
    // HTML-only message: text is derived, charset honoured.
    expect(second.bodyText).toBe("Thursday works & café is booked");
    expect(second.bodyHtml).toBe("<div>Thursday works &amp; café is booked</div>");
    expect(second.unread).toBe(true);
    expect(second.references).toHaveLength(3);
    expect(draft.draftId).toBe("r-555");
    expect(draft.bodyHtml).toBeNull();
    expect(draft.from).toEqual({ address: "" });
  });

  it("falls back to one message at a time when the whole thread is over the reply cap", async () => {
    const { bridge, provider } = setup();
    bridge.fail("gmail", "get_thread", statusError(502))
      .reply("gmail", "get_thread", GMAIL_THREAD_A_SUMMARY)
      .reply("gmail", "get_message", GMAIL_MESSAGE_A1_FULL, GMAIL_MESSAGE_A2_FULL);
    const thread = await provider.getThread("18c1a");
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["get_thread", { threadId: "18c1a", format: "full" }],
      ["get_thread", { threadId: "18c1a", format: "summary" }],
      ["get_message", { messageId: "m-a1" }],
      ["get_message", { messageId: "m-a2" }],
    ]);
    expect(thread.messages.map((message) => [message.id, message.unread])).toEqual([["m-a1", false], ["m-a2", true]]);
  });

  it("does not hide a rate limit behind the fallback", async () => {
    const { bridge, provider } = setup();
    bridge.fail("gmail", "get_thread", statusError(429));
    await expect(provider.getThread("18c1a")).rejects.toMatchObject({ code: "rate_limited" });
    expect(bridge.calls).toHaveLength(1);
  });

  it("serves a message it already holds from the cache", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "get_thread", { id: "18c1a", messages: [GMAIL_MESSAGE_A1_FULL] })
      .reply("gmail", "search", { messages: [{ id: "m-a1", threadId: "18c1a" }] });
    await provider.getThread("18c1a");
    const sent = await provider.listSentTo("ada@example.com", 5);
    expect(sent.map((message) => message.id)).toEqual(["m-a1"]);
    expect(bridge.callsTo("get_message")).toHaveLength(0);
  });

  it("ignores a draft label without draft ids gracefully", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "get_thread", { id: "18c1a", messages: [GMAIL_MESSAGE_A3_DRAFT] }).reply("gmail", "list_drafts", {});
    const thread = await provider.getThread("18c1a");
    expect(thread.messages[0].draftId).toBeUndefined();
  });
});

describe("gmail errors", () => {
  it.each([
    [404, "not_connected"],
    [409, "multiple_accounts"],
    [429, "rate_limited"],
    [403, "failed"],
    [503, "failed"],
  ])("maps a %i from the bridge to %s without provider text", async (status, code) => {
    const { bridge, provider } = setup(null);
    bridge.fail("gmail", "list_labels", statusError(status)).reply("gmail", "get_label", GMAIL_INBOX_LABEL);
    const error = await provider.listFolders().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toMatch(/tenant|upstream|HTTP|\/var/);
    expect(bridge.calls[0].label).toBeUndefined();
  });

  it("turns a bridge error without a status, or a reply without data, into failed", async () => {
    const { bridge, provider } = setup();
    bridge.fail("gmail", "get_thread", new Error("socket hang up at 10.0.0.4"));
    await expect(provider.getThread("abc")).rejects.toMatchObject({ code: "failed", message: "Something went wrong. Try again." });

    const odd = { service: async () => "not an envelope", integrations: async () => [], capabilities: async () => ({ version: 1, integrations: true, ai: false }) };
    const broken = createGmailProvider({ account: ACCOUNT, bridge: odd as never });
    await expect(broken.search("x")).rejects.toMatchObject({ code: "failed" });
  });
});
