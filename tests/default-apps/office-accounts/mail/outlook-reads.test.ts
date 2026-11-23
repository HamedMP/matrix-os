import { describe, expect, it } from "vitest";
import { createOutlookProvider } from "../../../../home/apps/_shared/office-accounts/mail/outlook-provider";
import { OUTLOOK_STARRED_ID } from "../../../../home/apps/_shared/office-accounts/mail/outlook-normalize";
import { mailAccountId, type MailAccount } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { FakeBridge, statusError } from "./fake-bridge";
import {
  IDS, OUTLOOK_ALPHA_FOLDER, OUTLOOK_ATTACHMENTS_A2, OUTLOOK_CONVERSATION_A, OUTLOOK_FOLDER_LIST, OUTLOOK_INBOX_PAGE,
  OUTLOOK_INBOX_PAGE_2, OUTLOOK_SEARCH_PAGE, OUTLOOK_WELL_KNOWN_REPLIES, graphMessage,
} from "./outlook-fixtures";

const SERVICE = "microsoft_outlook";
const ACCOUNT: MailAccount = { id: mailAccountId("outlook", "owner@contoso.com"), provider: "outlook", address: "owner@contoso.com", displayName: "Owner" };

function setup() {
  const bridge = new FakeBridge();
  const provider = createOutlookProvider({ account: ACCOUNT, label: "Contoso", bridge });
  return { bridge, provider };
}

function wellKnown(bridge: FakeBridge, extra: Record<string, unknown> = {}) {
  bridge.handle(SERVICE, "get_folder", (params) => {
    const reply = { ...OUTLOOK_WELL_KNOWN_REPLIES, ...extra }[params.folderId as string];
    if (!reply) throw statusError(400);
    return reply;
  });
}

describe("outlook listFolders", () => {
  it("finds standard folders by well-known name, adds a virtual flagged view and keeps the rest custom", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_folders", { value: [...OUTLOOK_FOLDER_LIST.value, OUTLOOK_ALPHA_FOLDER] });
    wellKnown(bridge);
    const folders = await provider.listFolders();

    expect(bridge.callsTo("list_folders")).toEqual([{ service: SERVICE, action: "list_folders", params: { limit: 100 }, label: "Contoso" }]);
    expect(bridge.callsTo("get_folder").map((call) => call.params.folderId).sort())
      .toEqual(["archive", "deleteditems", "drafts", "inbox", "junkemail", "sentitems"]);
    expect(folders).toEqual([
      { id: IDS.inbox, name: "Inbox", role: "inbox", unreadCount: 4 },
      { id: OUTLOOK_STARRED_ID, name: "Flagged", role: "starred", virtual: true },
      { id: IDS.sent, name: "Sent", role: "sent", unreadCount: 0 },
      { id: IDS.drafts, name: "Drafts", role: "drafts", unreadCount: 1 },
      { id: IDS.junk, name: "Junk", role: "spam", unreadCount: 0 },
      { id: IDS.deleted, name: "Deleted", role: "trash", unreadCount: 0 },
      { id: IDS.alpha, name: "Alpha", role: "custom", unreadCount: 0, parentId: IDS.projects },
      { id: IDS.projects, name: "Projects", role: "custom", unreadCount: 2 },
    ]);
  });

  it("pages through a long folder list and includes an archive found only by name", async () => {
    const { bridge, provider } = setup();
    const many = Array.from({ length: 100 }, (_, index) => ({ id: `F${index}`, displayName: `Folder ${index}`, parentFolderId: IDS.root }));
    bridge.reply(SERVICE, "list_folders", { value: many }, { value: [] });
    wellKnown(bridge, { archive: { id: "AAMkAGArchive=", displayName: "Archiv", parentFolderId: IDS.root, unreadItemCount: 0 } });
    const folders = await provider.listFolders();
    expect(bridge.callsTo("list_folders").map((call) => call.params)).toEqual([{ limit: 100 }, { limit: 100, skip: "100" }]);
    expect(folders.find((folder) => folder.role === "archive")).toEqual({ id: "AAMkAGArchive=", name: "Archive", role: "archive", unreadCount: 0 });
    expect(folders.filter((folder) => folder.role === "custom")).toHaveLength(100);
  });

  it("does not swallow a rate limit while resolving folders", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_folders", OUTLOOK_FOLDER_LIST);
    bridge.handle(SERVICE, "get_folder", () => { throw statusError(429); });
    await expect(provider.listFolders()).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("outlook listThreads and search", () => {
  it("groups a folder page into conversations, newest first", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_folder_messages", OUTLOOK_INBOX_PAGE);
    const page = await provider.listThreads({ folderId: IDS.inbox, limit: 3 });
    expect(bridge.calls[0]).toEqual({ service: SERVICE, action: "list_folder_messages", params: { folderId: IDS.inbox, top: 3 }, label: "Contoso" });
    expect(page.items).toEqual([
      {
        id: "conv-A",
        accountId: ACCOUNT.id,
        subject: "RE: Budget",
        snippet: "Numbers attached & ready",
        participants: [
          { name: "Grace Hopper", address: "grace@contoso.com" },
          { name: "Owner", address: "owner@contoso.com" },
          { address: "ken@contoso.com" },
        ],
        lastMessageAt: "2025-11-21T15:00:02Z",
        unread: true,
        flagged: true,
        hasAttachments: true,
        folderIds: [IDS.inbox],
        messageCount: 2,
      },
      expect.objectContaining({ id: "conv-B", subject: "Lunch?", unread: false, participants: [{ address: "linus@example.org" }, { name: "Owner", address: "owner@contoso.com" }] }),
    ]);
    expect(page.nextCursor).toBe("o.3");
  });

  it("pages by offset and leaves out conversations already shown on an earlier page", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_folder_messages", OUTLOOK_INBOX_PAGE, OUTLOOK_INBOX_PAGE_2);
    const first = await provider.listThreads({ folderId: IDS.inbox, limit: 3 });
    const second = await provider.listThreads({ folderId: IDS.inbox, limit: 3, cursor: first.nextCursor ?? undefined });
    expect(bridge.calls[1].params).toEqual({ folderId: IDS.inbox, top: 3, skip: 3 });
    expect(second.items.map((item) => item.id)).toEqual(["conv-C"]);
    expect(second.nextCursor).toBeNull();
  });

  it("lists the flagged view as the inbox with the fixed flagged filter", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_folder_messages", { value: [] });
    await provider.listThreads({ folderId: OUTLOOK_STARRED_ID, limit: 10 });
    expect(bridge.calls[0].params).toEqual({ folderId: "inbox", top: 10, filter: "flagged" });
  });

  it("searches inside a folder with a skip token cursor, and keeps only flagged results for the flagged view", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "search_messages", OUTLOOK_SEARCH_PAGE, { value: [] }, OUTLOOK_INBOX_PAGE);
    const page = await provider.listThreads({ folderId: IDS.inbox, limit: 25, query: "invoice\n" });
    expect(bridge.calls[0].params).toEqual({ query: "invoice", folderId: IDS.inbox, top: 25 });
    expect(page.items.map((item) => item.subject)).toEqual(["Invoice 42"]);
    expect(page.nextCursor).toBe("s.MSZZVlhZ");
    await provider.listThreads({ folderId: IDS.inbox, limit: 25, query: "invoice", cursor: page.nextCursor ?? undefined });
    expect(bridge.calls[1].params).toEqual({ query: "invoice", folderId: IDS.inbox, top: 25, skipToken: "MSZZVlhZ" });

    const flagged = await provider.listThreads({ folderId: OUTLOOK_STARRED_ID, limit: 25, query: "budget" });
    expect(bridge.calls[2].params).toEqual({ query: "budget", folderId: "inbox", top: 25 });
    expect(flagged.items.map((item) => [item.id, item.messageCount])).toEqual([["conv-A", 1]]);
  });

  it("searches every folder, rejects overlong or foreign input without calling", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "search_messages", OUTLOOK_SEARCH_PAGE);
    await provider.search("from:grace budget");
    expect(bridge.calls[0].params).toEqual({ query: "from:grace budget", top: 25 });
    await expect(provider.search("x".repeat(600))).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.listThreads({ folderId: IDS.inbox, limit: 5, cursor: "g.abc" })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.listThreads({ folderId: "inbox/../x", limit: 5 })).rejects.toMatchObject({ code: "not_supported" });
    expect(await provider.search("")).toEqual({ items: [], nextCursor: null });
    expect(bridge.calls).toHaveLength(1);
  });
});

describe("outlook getThread", () => {
  it("reads the conversation, sorts it, keeps HTML untrusted and lists attachments", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_conversation", OUTLOOK_CONVERSATION_A).reply(SERVICE, "list_attachments", OUTLOOK_ATTACHMENTS_A2);
    const thread = await provider.getThread("conv-A");
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["list_conversation", { conversationId: "conv-A", top: 50 }],
      ["list_attachments", { messageId: "msg-a2" }],
    ]);
    expect(thread).toMatchObject({ id: "conv-A", accountId: ACCOUNT.id, subject: "Budget", folderIds: [IDS.inbox, IDS.sent] });
    const [first, second] = thread.messages;
    expect(first).toEqual({
      id: "msg-a1",
      threadId: "conv-A",
      from: { name: "Owner", address: "owner@contoso.com" },
      to: [{ name: "Grace Hopper", address: "grace@contoso.com" }],
      cc: [],
      bcc: [{ address: "audit@contoso.com" }],
      sentAt: "2025-11-21T10:00:00Z",
      subject: "Budget",
      bodyText: "Can you send the numbers?",
      bodyHtml: null,
      attachments: [],
      messageIdHeader: "<x@outlook.example>",
      references: [],
      unread: false,
    });
    expect(second.bodyHtml).toContain("tracker.example");
    expect(second.bodyText).toBe("Numbers attached & ready.");
    expect(second.unread).toBe(true);
    expect(second.attachments).toEqual([
      { id: "att-1", name: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 18000 },
      { id: "att-2", name: "image001.png", mimeType: "image/png", size: 3000, inline: true },
    ]);
  });

  it("marks drafts with their draft id and pages long conversations", async () => {
    const { bridge, provider } = setup();
    const page = Array.from({ length: 50 }, (_, index) => graphMessage({ id: `m${index}`, conversationId: "conv-L", receivedDateTime: `2025-11-0${(index % 9) + 1}T10:00:00Z` }));
    bridge.reply(SERVICE, "list_conversation", { value: page }, { value: [graphMessage({ id: "d1", conversationId: "conv-L", isDraft: true })] });
    const thread = await provider.getThread("conv-L");
    expect(bridge.callsTo("list_conversation").map((call) => call.params)).toEqual([
      { conversationId: "conv-L", top: 50 },
      { conversationId: "conv-L", top: 50, skip: 50 },
    ]);
    expect(thread.messages).toHaveLength(51);
    expect(thread.messages.find((message) => message.id === "d1")?.draftId).toBe("d1");
  });

  it("falls back to one message at a time when the conversation is over the reply cap", async () => {
    const { bridge, provider } = setup();
    bridge.fail(SERVICE, "list_conversation", statusError(502))
      .reply(SERVICE, "list_conversation", { value: [graphMessage({ id: "p1", conversationId: "conv-P" }), graphMessage({ id: "p2", conversationId: "conv-P" })] });
    bridge.handle(SERVICE, "get_message", (params) => graphMessage({ id: params.messageId, conversationId: "conv-P", body: { contentType: "html", content: "<p>hi</p>" } }));
    const thread = await provider.getThread("conv-P");
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["list_conversation", { conversationId: "conv-P", top: 50 }],
      ["list_conversation", { conversationId: "conv-P", top: 50, includeBody: false }],
      ["get_message", { messageId: "p1" }],
      ["get_message", { messageId: "p2" }],
    ]);
    expect(thread.messages.map((message) => message.bodyText)).toEqual(["hi", "hi"]);
  });

  it("reports an unknown conversation as not found and a 404 as not connected", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_conversation", { value: [] }).fail(SERVICE, "list_conversation", statusError(404));
    await expect(provider.getThread("conv-none")).rejects.toMatchObject({ code: "not_supported" });
    const error = await provider.getThread("conv-x").catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "not_connected" });
    expect(error.message).not.toMatch(/tenant|HTTP/);
  });
});
