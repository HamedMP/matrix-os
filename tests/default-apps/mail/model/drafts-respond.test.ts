/**
 * Replies and forwards built from a thread: never from the owner's own unsent
 * draft, addressed to Reply-To when the sender set one, and forwards carry the
 * original's files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeGmailMessage } from "../../../../home/apps/_shared/office-accounts/mail/gmail-normalize";
import { normalizeGraphMessage } from "../../../../home/apps/_shared/office-accounts/mail/outlook-normalize";
import { MAX_DRAFT_REQUEST_BYTES, type AttachmentContent } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { buildDraftFromThread } from "../../../../home/apps/mail/src/model/drafts";
import { createMailStore } from "../../../../home/apps/mail/src/model/store";
import { noMailCache } from "../../../../home/apps/mail/src/model/cache";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { b64url } from "../../office-accounts/mail/fake-bridge";
import { GMAIL, GMAIL_FOLDERS, message, summary, thread } from "./fixtures";
import { FakeProvider } from "./fake-provider";

const OPTIONS = { owner: GMAIL, timeZone: "UTC" };

describe("replying next to a saved draft", () => {
  const conversation = thread("t1", [
    message("m1", { from: { name: "Bob", address: "bob@example.com" }, to: [{ address: "me@example.com" }], bodyText: "Can you come?" }),
    message("d1", { from: { address: "me@example.com" }, to: [{ address: "someone@example.com" }], bodyText: "My unsent words", draftId: "draft-1" }),
  ]);

  it("refuses to answer the owner's own unsent draft", () => {
    expect(() => buildDraftFromThread("reply", conversation, { ...OPTIONS, messageId: "d1" })).toThrow(RangeError);
  });

  it("answers the last sent message when no message is named", () => {
    const built = buildDraftFromThread("reply", conversation, OPTIONS);
    expect(built.draft).toMatchObject({ to: [{ name: "Bob", address: "bob@example.com" }], inReplyToMessageId: "m1" });
    expect(built.quote?.text).toContain("Can you come?");
    expect(built.quote?.text).not.toContain("My unsent words");
  });
});

describe("Reply-To", () => {
  const listPost = message("m1", {
    from: { name: "Vendor", address: "noreply@vendor.com" },
    replyTo: [{ name: "Support", address: "support@vendor.com" }],
    to: [{ address: "me@example.com" }, { address: "carol@example.com" }],
  });

  it("is read from Gmail and Graph messages", () => {
    const gmail = normalizeGmailMessage({
      id: "g1", threadId: "t1", internalDate: "1763000000000",
      payload: { mimeType: "text/plain", headers: [
        { name: "From", value: "noreply@vendor.com" }, { name: "Reply-To", value: "Support <support@vendor.com>" },
      ], body: { data: b64url("hi") } },
    });
    expect(gmail.replyTo).toEqual([{ name: "Support", address: "support@vendor.com" }]);
    const graph = normalizeGraphMessage({
      id: "o1", conversationId: "c1", from: { emailAddress: { address: "noreply@vendor.com" } },
      replyTo: [{ emailAddress: { name: "Support", address: "support@vendor.com" } }],
    });
    expect(graph.replyTo).toEqual([{ name: "Support", address: "support@vendor.com" }]);
  });

  it("addresses a reply to Reply-To instead of From", () => {
    const built = buildDraftFromThread("reply", thread("t1", [listPost]), OPTIONS);
    expect(built.draft.to).toEqual([{ name: "Support", address: "support@vendor.com" }]);
  });

  it("puts Reply-To with the other recipients for Reply all", () => {
    const built = buildDraftFromThread("replyAll", thread("t1", [listPost]), OPTIONS);
    expect(built.draft.to.map((entry) => entry.address)).toEqual(["support@vendor.com", "carol@example.com"]);
  });
});

describe("forwarding with attachments", () => {
  const key = threadKey(GMAIL.id, "t1");

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(attachments: Parameters<typeof message>[1]["attachments"], content: (id: string) => AttachmentContent) {
    const provider = new FakeProvider(GMAIL_FOLDERS);
    provider.lists.INBOX = [summary("t1")];
    provider.threads.t1 = thread("t1", [message("m1", { subject: "Invoice", attachments })]);
    const fetched: string[] = [];
    provider.getAttachment = async (_messageId: string, attachmentId: string) => {
      fetched.push(attachmentId);
      return content(attachmentId);
    };
    const failures: string[] = [];
    const store = createMailStore({ accounts: [{ account: GMAIL, provider }], cache: noMailCache, logger: (event) => failures.push(event), timeZone: "UTC", autosaveMs: 1000 });
    await store.start();
    return { store, provider, fetched };
  }

  it("adds the original's files, not its inline images, to the forward", async () => {
    const { store, fetched } = await setup([
      { id: "att-pdf", name: "invoice.pdf", mimeType: "application/pdf", size: 4 },
      { id: "att-logo", name: "logo.png", mimeType: "image/png", size: 4, inline: true },
    ], (id) => ({ name: "invoice.pdf", mimeType: "application/pdf", size: 4, contentBase64: id === "att-pdf" ? "JVBERg==" : "x" }));
    const id = await store.respond("forward", { key });
    expect(fetched).toEqual(["att-pdf"]);
    expect(store.getSnapshot().drafts[id!].draft.attachments).toEqual([
      { name: "invoice.pdf", mimeType: "application/pdf", size: 4, contentBase64: "JVBERg==" },
    ]);
  });

  it("refuses a forward whose files do not fit in a draft instead of dropping them", async () => {
    const { store, fetched } = await setup([
      { id: "att-big", name: "scan.pdf", mimeType: "application/pdf", size: MAX_DRAFT_REQUEST_BYTES },
    ], () => { throw new Error("must not fetch"); });
    expect(await store.respond("forward", { key })).toBeNull();
    expect(fetched).toEqual([]);
    expect(Object.keys(store.getSnapshot().drafts)).toHaveLength(0);
    expect(store.getSnapshot().error?.message).toMatch(/too large/i);
  });
});
