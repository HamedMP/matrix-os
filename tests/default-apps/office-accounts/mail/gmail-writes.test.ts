import { describe, expect, it } from "vitest";
import { createGmailProvider } from "../../../../home/apps/_shared/office-accounts/mail/gmail-provider";
import { GMAIL_ARCHIVE_ID } from "../../../../home/apps/_shared/office-accounts/mail/gmail-normalize";
import {
  archiveChange, emptyDraft, mailAccountId, moveChange, trashChange,
  type Draft, type MailAccount,
} from "../../../../home/apps/_shared/office-accounts/types/mail";
import { FakeBridge, b64, statusError } from "./fake-bridge";
import {
  GMAIL_ATTACHMENT, GMAIL_INBOX_LABEL, GMAIL_LABELS, GMAIL_MESSAGE_A1_FULL, GMAIL_SENT_SEARCH, GMAIL_THREAD_A_SUMMARY,
  GMAIL_THREAD_LIST_PAGE_1, GMAIL_THREAD_B_SUMMARY, gmailSentMessage,
} from "./gmail-fixtures";

const ACCOUNT: MailAccount = { id: mailAccountId("gmail", "owner@example.com"), provider: "gmail", address: "owner@example.com", displayName: "Owner" };

function setup() {
  const bridge = new FakeBridge();
  const provider = createGmailProvider({ account: ACCOUNT, label: "work", bridge });
  return { bridge, provider };
}

async function listedInbox() {
  const ctx = setup();
  ctx.bridge.reply("gmail", "list_threads_query", GMAIL_THREAD_LIST_PAGE_1)
    .reply("gmail", "get_thread", GMAIL_THREAD_A_SUMMARY, GMAIL_THREAD_B_SUMMARY);
  await ctx.provider.listThreads({ folderId: "INBOX", limit: 25 });
  ctx.bridge.calls.length = 0;
  return ctx;
}

async function folders(ctx: ReturnType<typeof setup>) {
  ctx.bridge.reply("gmail", "list_labels", GMAIL_LABELS).reply("gmail", "get_label", GMAIL_INBOX_LABEL);
  const list = await ctx.provider.listFolders();
  ctx.bridge.calls.length = 0;
  return list;
}

describe("gmail modifyThreads", () => {
  it("archives by removing INBOX from every message of the listed threads", async () => {
    const ctx = await listedInbox();
    const change = archiveChange(await folders(ctx));
    ctx.bridge.reply("gmail", "batch_modify", undefined);
    await ctx.provider.modifyThreads(["18c1a", "18c2b"], change);
    expect(ctx.bridge.calls.map(({ action, params, label }) => ({ action, params, label }))).toEqual([
      { action: "batch_modify", params: { messageIds: ["m-a1", "m-a2", "m-b1"], removeLabelIds: ["INBOX"] }, label: "work" },
    ]);
  });

  it("marks read, flags, trashes and moves with label changes", async () => {
    const ctx = await listedInbox();
    const list = await folders(ctx);
    ctx.bridge.reply("gmail", "batch_modify", undefined, undefined, undefined, undefined);
    await ctx.provider.modifyThreads(["18c2b"], { read: true, flagged: true });
    await ctx.provider.modifyThreads(["18c2b"], { read: false, flagged: false });
    await ctx.provider.modifyThreads(["18c2b"], trashChange(list, "INBOX"));
    await ctx.provider.modifyThreads(["18c2b"], moveChange("INBOX", "Label_30"));
    expect(ctx.bridge.calls.map((call) => call.params)).toEqual([
      { messageIds: ["m-b1"], addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
      { messageIds: ["m-b1"], addLabelIds: ["UNREAD"], removeLabelIds: ["STARRED"] },
      { messageIds: ["m-b1"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { messageIds: ["m-b1"], addLabelIds: ["Label_30"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("looks up message ids for a thread it has not listed, and splits over 100 messages", async () => {
    const { bridge, provider } = setup();
    const many = { id: "big", messages: Array.from({ length: 130 }, (_, index) => ({ id: `m${index}`, labelIds: ["INBOX"] })) };
    bridge.reply("gmail", "get_thread", many).reply("gmail", "batch_modify", undefined, undefined);
    await provider.modifyThreads(["big"], { read: true });
    expect(bridge.calls.map((call) => [call.action, (call.params.messageIds as string[] | undefined)?.length ?? call.params])).toEqual([
      ["get_thread", { threadId: "big", format: "summary" }],
      ["batch_modify", 100],
      ["batch_modify", 30],
    ]);
  });

  it("refuses virtual, provider-owned and conflicting labels and too many threads, without calling", async () => {
    const { bridge, provider } = setup();
    await expect(provider.modifyThreads(["t1"], { addFolders: [GMAIL_ARCHIVE_ID] })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.modifyThreads(["t1"], { removeFolders: ["SENT"] })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.modifyThreads(["t1"], { addFolders: ["Label_1"], removeFolders: ["Label_1"] })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.modifyThreads(Array.from({ length: 101 }, (_, i) => `t${i}`), { read: true })).rejects.toMatchObject({ code: "not_supported" });
    await provider.modifyThreads([], { read: true });
    await provider.modifyThreads(["t1"], {});
    expect(bridge.calls).toHaveLength(0);
  });

  it("never retries a failed write", async () => {
    const ctx = await listedInbox();
    ctx.bridge.fail("gmail", "batch_modify", statusError(503));
    await expect(ctx.provider.modifyThreads(["18c1a"], { read: true })).rejects.toMatchObject({ code: "failed" });
    expect(ctx.bridge.callsTo("batch_modify")).toHaveLength(1);
  });
});

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft(),
    to: [{ address: "ada@example.com", name: "Ada\r\nBcc: evil@x.com" }],
    cc: [{ address: "bob@example.com" }],
    subject: "Plan\u0007",
    bodyHtml: "<p>Hello</p>",
    bodyText: "Hello",
    ...overrides,
  };
}

describe("gmail drafts and send", () => {
  it("creates a new draft through create_html_draft with cleaned fields", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "create_html_draft", { id: "r-1", message: { id: "m-new", threadId: "t-new", labelIds: ["DRAFT"] } });
    const saved = await provider.saveDraft(draft({
      attachments: [{ name: "a/b\"c.txt", mimeType: "text/plain", size: 5, contentBase64: b64("hello") }],
    }));
    expect(bridge.calls[0]).toEqual({
      service: "gmail", action: "create_html_draft", label: "work",
      params: {
        to: [{ address: "ada@example.com", name: "AdaBcc: evil@x.com" }],
        cc: [{ address: "bob@example.com" }],
        subject: "Plan",
        bodyHtml: "<p>Hello</p>",
        bodyText: "Hello",
        attachments: [{ filename: "a_b_c.txt", mimeType: "text/plain", contentBase64: "aGVsbG8=" }],
      },
    });
    expect(saved).toMatchObject({ id: "r-1", threadId: "t-new" });
    expect(saved.attachments[0].id).toEqual(expect.any(String));
  });

  it("replaces a stored draft, resending remembered attachment content", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "create_html_draft", { id: "r-1", message: { id: "m-new", threadId: "t-new" } })
      .reply("gmail", "update_draft", { id: "r-1", message: { id: "m-new2", threadId: "t-new" } });
    const saved = await provider.saveDraft(draft({ attachments: [{ name: "x.txt", mimeType: "text/plain", size: 5, contentBase64: b64("hello") }] }));
    const stored = { ...saved, bodyText: "Hello again", bodyHtml: "", attachments: saved.attachments.map(({ contentBase64: _c, ...rest }) => rest) };
    await provider.saveDraft(stored);
    expect(bridge.calls[1]).toMatchObject({
      action: "update_draft",
      params: {
        draftId: "r-1", subject: "Plan", bodyText: "Hello again", bodyHtml: "Hello again",
        attachments: [{ filename: "x.txt", mimeType: "text/plain", contentBase64: "aGVsbG8=" }],
      },
    });
  });

  it("asks for the file again when a stored attachment's content is unknown", async () => {
    const { bridge, provider } = setup();
    await expect(provider.saveDraft(draft({ id: "r-9", attachments: [{ id: "att", name: "x", mimeType: "text/plain", size: 1 }] })))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toHaveLength(0);
  });

  it("creates a threaded reply with In-Reply-To and References from the original", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "get_message", GMAIL_MESSAGE_A1_FULL)
      .reply("gmail", "create_reply_draft", { id: "r-2", message: { id: "m-r", threadId: "18c1a" } });
    const saved = await provider.saveDraft(draft({ inReplyToMessageId: "m-a1", subject: "Re: Review – Q3" }));
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["get_message", { messageId: "m-a1" }],
      ["create_reply_draft", {
        to: [{ address: "ada@example.com", name: "AdaBcc: evil@x.com" }],
        cc: [{ address: "bob@example.com" }],
        subject: "Re: Review – Q3",
        bodyHtml: "<p>Hello</p>",
        bodyText: "Hello",
        threadId: "18c1a",
        inReplyTo: "<CAF-a1@mail.example.com>",
        references: ["<root@mail.example.com>", "<mid@mail.example.com>", "<CAF-a1@mail.example.com>"],
      }],
    ]);
    expect(saved).toMatchObject({ id: "r-2", threadId: "18c1a", inReplyToMessageId: "m-a1" });
  });

  it("rejects a draft the gateway would refuse before any call", async () => {
    const { bridge, provider } = setup();
    await expect(provider.saveDraft(draft({ to: [{ address: "not an address" }] }))).rejects.toMatchObject({
      code: "not_supported", message: "One of the addresses is not valid.",
    });
    await expect(provider.saveDraft(draft({ bodyHtml: "x".repeat(70_000) }))).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toHaveLength(0);
  });

  it("sends and deletes by draft id only", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "send_draft", { id: "m-sent", threadId: "t", labelIds: ["SENT"] }).reply("gmail", "delete_draft", undefined);
    await provider.sendDraft("r-1");
    await provider.deleteDraft?.("r-2");
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["send_draft", { draftId: "r-1" }],
      ["delete_draft", { draftId: "r-2" }],
    ]);
    await expect(provider.sendDraft("r 1")).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toHaveLength(2);
  });
});

describe("gmail attachments and sent samples", () => {
  it("reads an attachment and converts base64url to standard base64", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "get_message", GMAIL_MESSAGE_A1_FULL).reply("gmail", "get_attachment", GMAIL_ATTACHMENT);
    const content = await provider.getAttachment("m-a1", "ANGjdJ8");
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["get_message", { messageId: "m-a1" }],
      ["get_attachment", { messageId: "m-a1", attachmentId: "ANGjdJ8" }],
    ]);
    expect(content).toEqual({ name: "agenda.pdf", mimeType: "application/pdf", size: 13, contentBase64: "aGVsbG8/Pj53b3JsZA==" });
  });

  it("refuses an attachment over 1 MiB before downloading it", async () => {
    const { bridge, provider } = setup();
    const big = structuredClone(GMAIL_MESSAGE_A1_FULL);
    big.payload.parts[1].body = { size: 5_000_000, attachmentId: "ANGjdJ8" };
    bridge.reply("gmail", "get_message", big);
    await expect(provider.getAttachment("m-a1", "ANGjdJ8")).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("get_attachment")).toHaveLength(0);
  });

  it("lists recent sent messages to one address, newest first", async () => {
    const { bridge, provider } = setup();
    bridge.reply("gmail", "search", GMAIL_SENT_SEARCH)
      .reply("gmail", "get_message", gmailSentMessage("m-s1", "1763000000000", "older"), gmailSentMessage("m-s2", "1763500000000", "newer"));
    const sent = await provider.listSentTo(" Ada@Example.com ", 2);
    expect(bridge.calls.map((call) => [call.action, call.params])).toEqual([
      ["search", { query: "in:sent to:ada@example.com", maxResults: 2 }],
      ["get_message", { messageId: "m-s1" }],
      ["get_message", { messageId: "m-s2" }],
    ]);
    expect(sent.map((message) => message.bodyText)).toEqual(["newer", "older"]);
    await expect(provider.listSentTo("ada@example.com OR to:x", 2)).rejects.toMatchObject({ code: "not_supported" });
  });
});
