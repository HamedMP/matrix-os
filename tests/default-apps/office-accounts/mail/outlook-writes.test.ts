import { describe, expect, it } from "vitest";
import { createOutlookProvider } from "../../../../home/apps/_shared/office-accounts/mail/outlook-provider";
import { OUTLOOK_STARRED_ID } from "../../../../home/apps/_shared/office-accounts/mail/outlook-normalize";
import {
  emptyDraft, mailAccountId, moveChange, type Draft, type MailAccount,
} from "../../../../home/apps/_shared/office-accounts/types/mail";
import { FakeBridge, b64, statusError } from "./fake-bridge";
import {
  IDS, OUTLOOK_ATTACHMENTS_A2, OUTLOOK_ATTACHMENT_CONTENT, OUTLOOK_CONVERSATION_A, OUTLOOK_SENT_SEARCH, fullSent, graphMessage, writeEcho,
} from "./outlook-fixtures";

const SERVICE = "microsoft_outlook";
const ACCOUNT: MailAccount = { id: mailAccountId("outlook", "owner@contoso.com"), provider: "outlook", address: "owner@contoso.com", displayName: "Owner" };

function setup() {
  const bridge = new FakeBridge();
  const provider = createOutlookProvider({ account: ACCOUNT, label: "Contoso", bridge });
  return { bridge, provider };
}

const actions = (bridge: FakeBridge) => bridge.calls.map((call) => [call.action, call.params]);

describe("outlook modifyThreads", () => {
  it("moves only the messages in the folder being left, and skips state that already matches", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_conversation", OUTLOOK_CONVERSATION_A).reply(SERVICE, "list_attachments", OUTLOOK_ATTACHMENTS_A2);
    await provider.getThread("conv-A");
    bridge.calls.length = 0;
    bridge.handle(SERVICE, "move_message", (params) => writeEcho(params.messageId as string, { parentFolderId: params.destinationFolderId }));
    bridge.handle(SERVICE, "update_message", (params) => writeEcho(params.messageId as string));

    await provider.modifyThreads(["conv-A"], { ...moveChange(IDS.inbox, "AAMkAGArchive="), read: true });
    expect(actions(bridge)).toEqual([
      ["update_message", { messageId: "msg-a2", isRead: true }],
      ["move_message", { messageId: "msg-a2", destinationFolderId: "AAMkAGArchive=" }],
    ]);

    // The adapter remembers the new state: the same change again writes nothing.
    bridge.calls.length = 0;
    await provider.modifyThreads(["conv-A"], { addFolders: ["AAMkAGArchive="], removeFolders: [IDS.inbox], read: true });
    expect(bridge.calls).toHaveLength(0);
  });

  it("trashes a whole thread, flags each message and reads message ids it does not hold", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_conversation", {
      value: [
        graphMessage({ id: "t1", conversationId: "conv-T", parentFolderId: IDS.inbox }),
        graphMessage({ id: "t2", conversationId: "conv-T", parentFolderId: IDS.sent }),
      ],
    });
    bridge.handle(SERVICE, "move_message", (params) => writeEcho(params.messageId as string));
    bridge.handle(SERVICE, "update_message", (params) => writeEcho(params.messageId as string));
    await provider.modifyThreads(["conv-T"], { addFolders: [IDS.deleted], flagged: true });
    expect(actions(bridge)).toEqual([
      ["list_conversation", { conversationId: "conv-T", top: 50, includeBody: false }],
      ["update_message", { messageId: "t1", flagged: true }],
      ["update_message", { messageId: "t2", flagged: true }],
      ["move_message", { messageId: "t1", destinationFolderId: IDS.deleted }],
      ["move_message", { messageId: "t2", destinationFolderId: IDS.deleted }],
    ]);
  });

  it("refuses a remove-only change, the virtual flagged view and too many threads, without calling", async () => {
    const { bridge, provider } = setup();
    await expect(provider.modifyThreads(["c1"], { removeFolders: [IDS.inbox] })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.modifyThreads(["c1"], { addFolders: [OUTLOOK_STARRED_ID] })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.modifyThreads(Array.from({ length: 101 }, (_, i) => `c${i}`), { read: true })).rejects.toMatchObject({ code: "not_supported" });
    await provider.modifyThreads(["c1"], {});
    expect(bridge.calls).toHaveLength(0);
  });

  it("stops at the first failed write and does not retry it", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_conversation", { value: [graphMessage({ id: "f1", conversationId: "conv-F", isRead: false })] })
      .fail(SERVICE, "update_message", statusError(429));
    await expect(provider.modifyThreads(["conv-F"], { read: true })).rejects.toMatchObject({ code: "rate_limited" });
    expect(bridge.callsTo("update_message")).toHaveLength(1);
  });
});

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft(),
    to: [{ address: "grace@contoso.com", name: "Grace Hopper" }],
    bcc: [{ address: "audit@contoso.com" }],
    subject: "Budget",
    bodyHtml: "<p>Attached.</p>",
    bodyText: "Attached.",
    ...overrides,
  };
}

const file = (name: string, text: string) => ({ name, mimeType: "text/plain", size: text.length, contentBase64: b64(text) });

describe("outlook drafts", () => {
  it("creates an HTML draft with recipients, then stores each attachment", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_html_draft", writeEcho("draft-1"))
      .reply(SERVICE, "add_attachment", { id: "att-a", name: "a.txt", contentType: "text/plain", size: 1 });
    const saved = await provider.saveDraft(draft({ attachments: [file("a.txt", "a")] }));
    expect(actions(bridge)).toEqual([
      ["create_html_draft", {
        toRecipients: [{ address: "grace@contoso.com", name: "Grace Hopper" }], ccRecipients: [], bccRecipients: [{ address: "audit@contoso.com" }],
        subject: "Budget", bodyHtml: "<p>Attached.</p>",
      }],
      ["add_attachment", { messageId: "draft-1", name: "a.txt", contentType: "text/plain", contentBase64: "YQ==" }],
    ]);
    expect(saved).toMatchObject({ id: "draft-1", threadId: "conv-D", attachments: [{ id: "att-a", name: "a.txt" }] });
  });

  it("creates a reply draft, then sets the owner's recipients and subject", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_reply_draft", writeEcho("draft-r", { conversationId: "conv-A" })).reply(SERVICE, "update_draft", writeEcho("draft-r"));
    const saved = await provider.saveDraft(draft({ inReplyToMessageId: "msg-a2", subject: "RE: Budget", bodyHtml: "", bodyText: "Thanks\nG" }));
    expect(actions(bridge)).toEqual([
      ["create_reply_draft", { messageId: "msg-a2", replyAll: false, bodyHtml: "Thanks<br>G" }],
      ["update_draft", {
        messageId: "draft-r", subject: "RE: Budget",
        toRecipients: [{ address: "grace@contoso.com", name: "Grace Hopper" }], ccRecipients: [], bccRecipients: [{ address: "audit@contoso.com" }],
      }],
    ]);
    expect(saved).toMatchObject({ id: "draft-r", threadId: "conv-A" });
  });

  it("updates a stored draft and adds only new attachments", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_html_draft", writeEcho("draft-1"))
      .reply(SERVICE, "add_attachment", { id: "att-a" }, { id: "att-b" })
      .reply(SERVICE, "update_draft", writeEcho("draft-1"));
    const saved = await provider.saveDraft(draft({ attachments: [file("a.txt", "a")] }));
    bridge.calls.length = 0;
    await provider.saveDraft({ ...saved, subject: "Budget v2", attachments: [...saved.attachments, file("b.txt", "b")] });
    expect(actions(bridge)).toEqual([
      ["update_draft", {
        messageId: "draft-1", subject: "Budget v2", bodyHtml: "<p>Attached.</p>",
        toRecipients: [{ address: "grace@contoso.com", name: "Grace Hopper" }], ccRecipients: [], bccRecipients: [{ address: "audit@contoso.com" }],
      }],
      ["add_attachment", { messageId: "draft-1", name: "b.txt", contentType: "text/plain", contentBase64: "Yg==" }],
    ]);
  });

  it("recreates a draft that drops a stored attachment, then moves the old one to Deleted Items", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_attachments", { value: [{ id: "att-a", name: "a.txt", contentType: "text/plain", size: 1 }, { id: "att-b", name: "b.txt", size: 1 }] })
      .reply(SERVICE, "create_html_draft", writeEcho("draft-2"))
      .reply(SERVICE, "add_attachment", { id: "att-a2" })
      .reply(SERVICE, "delete_draft", writeEcho("draft-1", { parentFolderId: IDS.deleted }));
    const saved = await provider.saveDraft(draft({ id: "draft-1", attachments: [{ id: "att-a", ...file("a.txt", "a") }] }));
    expect(actions(bridge).map(([action]) => action)).toEqual(["list_attachments", "create_html_draft", "add_attachment", "delete_draft"]);
    expect(bridge.callsTo("delete_draft")[0].params).toEqual({ messageId: "draft-1" });
    expect(saved).toMatchObject({ id: "draft-2", attachments: [{ id: "att-a2" }] });
  });

  it("asks for a file again before any write when its content is unknown", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_attachments", { value: [{ id: "att-a" }, { id: "att-b" }] });
    await expect(provider.saveDraft(draft({ id: "draft-1", attachments: [{ id: "att-a", name: "a.txt", mimeType: "text/plain", size: 1 }] })))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls.map((call) => call.action)).toEqual(["list_attachments"]);
  });

  it("sends and discards by id only", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "send_draft", undefined).reply(SERVICE, "delete_draft", writeEcho("draft-9"));
    await provider.sendDraft("draft-1");
    await provider.deleteDraft?.("draft-9");
    expect(actions(bridge)).toEqual([["send_draft", { messageId: "draft-1" }], ["delete_draft", { messageId: "draft-9" }]]);
    await expect(provider.sendDraft("../x")).rejects.toMatchObject({ code: "not_supported" });
  });
});

describe("outlook attachments and sent samples", () => {
  it("checks the size first, then reads the content", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_attachments", OUTLOOK_ATTACHMENTS_A2).reply(SERVICE, "get_attachment", OUTLOOK_ATTACHMENT_CONTENT);
    const content = await provider.getAttachment("msg-a2", "att-1");
    expect(actions(bridge)).toEqual([
      ["list_attachments", { messageId: "msg-a2" }],
      ["get_attachment", { messageId: "msg-a2", attachmentId: "att-1" }],
    ]);
    expect(content).toEqual({
      name: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 11, contentBase64: "aGVsbG8gd29ybGQ=",
    });
  });

  it("refuses an oversized, missing or content-less attachment", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_attachments", { value: [{ id: "big", name: "big.zip", size: 3_000_000 }] }, { value: [] }, { value: [{ id: "item", size: 10 }] })
      .reply(SERVICE, "get_attachment", { id: "item", name: "Forwarded", "@odata.type": "#microsoft.graph.itemAttachment" });
    await expect(provider.getAttachment("m1", "big")).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.getAttachment("m1", "gone")).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.getAttachment("m1", "item")).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("get_attachment")).toHaveLength(1);
  });

  it("lists sent messages to one address, keeps the owner's own and reads their bodies", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "search_messages", OUTLOOK_SENT_SEARCH);
    bridge.handle(SERVICE, "get_message", (params) => params.messageId === "sent-1"
      ? fullSent("sent-1", "2025-11-01T10:00:00Z", "<p>Hi Grace, older</p>")
      : fullSent("sent-3", "2025-11-05T10:00:00Z", "<p>Hi Grace, newer</p>"));
    const sent = await provider.listSentTo("Grace@Contoso.com", 5);
    expect(actions(bridge)).toEqual([
      ["search_messages", { query: "to:grace@contoso.com", folderId: "sentitems", top: 5 }],
      ["get_message", { messageId: "sent-1" }],
      ["get_message", { messageId: "sent-3" }],
    ]);
    expect(sent.map((message) => message.bodyText)).toEqual(["Hi Grace, newer", "Hi Grace, older"]);
  });
});
