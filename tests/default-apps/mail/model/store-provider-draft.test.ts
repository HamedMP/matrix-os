/**
 * A draft the provider stores can be opened again, edited and sent; saving
 * updates that draft instead of creating a copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailStore } from "../../../../home/apps/mail/src/model/store";
import { noMailCache } from "../../../../home/apps/mail/src/model/cache";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { GMAIL, GMAIL_FOLDERS, OUTLOOK, message, summary, thread } from "./fixtures";
import { FakeProvider } from "./fake-provider";

const key = threadKey(GMAIL.id, "t1");

async function setup(account = GMAIL) {
  const provider = new FakeProvider(GMAIL_FOLDERS);
  provider.lists.INBOX = [summary("t1", { accountId: account.id })];
  provider.threads.t1 = thread("t1", [
    message("m1", { from: { name: "Bob", address: "bob@example.com" }, bodyText: "Can you come?" }),
    message("d1", {
      from: { address: "me@example.com" }, to: [{ name: "Bob", address: "bob@example.com" }], subject: "Re: Plans",
      bodyText: "Yes, I will\n\n> Can you come?", draftId: "draft-9",
      attachments: [
        { id: "att-1", name: "notes.txt", mimeType: "text/plain", size: 2 },
        { id: "att-img", name: "logo.png", mimeType: "image/png", size: 4, inline: true },
      ],
    }),
  ], { accountId: account.id });
  const fetched: string[] = [];
  provider.getAttachment = async (_messageId: string, attachmentId: string) => {
    fetched.push(attachmentId);
    return { name: "notes.txt", mimeType: "text/plain", size: 2, contentBase64: "aGk=" };
  };
  const store = createMailStore({ accounts: [{ account, provider }], cache: noMailCache, logger: () => undefined, timeZone: "UTC", autosaveMs: 1000 });
  await store.start();
  return { store, provider, fetched, key: threadKey(account.id, "t1") };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("editProviderDraft", () => {
  it("opens a stored Gmail draft with its id, recipients, body and file content", async () => {
    const { store, provider, fetched } = await setup();
    const id = await store.editProviderDraft(key, "d1", { bodyHtml: "<p>Yes, I will</p>" });
    const state = store.getSnapshot().drafts[id!];
    expect(store.getSnapshot().activeDraftId).toBe(id);
    expect(state).toMatchObject({ open: true, kind: "reply", quote: null, revision: 0 });
    expect(state.draft).toMatchObject({
      id: "draft-9", threadId: "t1", inReplyToMessageId: "m1", subject: "Re: Plans",
      to: [{ name: "Bob", address: "bob@example.com" }], bodyHtml: "<p>Yes, I will</p>", bodyText: "Yes, I will\n\n> Can you come?",
      attachments: [{ id: "att-1", name: "notes.txt", contentBase64: "aGk=" }],
    });
    expect(fetched).toEqual(["att-1"]);

    store.editDraft(id!, { subject: "Re: Plans (updated)" });
    await store.saveDraft(id!);
    expect(provider.calls.saveDraft).toHaveLength(1);
    expect(provider.calls.saveDraft[0]).toMatchObject({ id: "draft-9", subject: "Re: Plans (updated)" });
    expect(await store.sendDraft(id!)).toBe(true);
    expect(provider.calls.sendDraft).toEqual(["draft-9"]);
  });

  it("keeps Outlook's stored files by id without reading them", async () => {
    const { store, fetched, key: outlookKey } = await setup(OUTLOOK);
    const id = await store.editProviderDraft(outlookKey, "d1");
    expect(fetched).toEqual([]);
    expect(store.getSnapshot().drafts[id!].draft.attachments).toEqual([{ id: "att-1", name: "notes.txt", mimeType: "text/plain", size: 2 }]);
    expect(store.getSnapshot().drafts[id!].draft.bodyHtml).toContain("Yes, I will");
  });

  it("reopens the same local draft instead of loading a second copy", async () => {
    const { store } = await setup();
    const first = await store.editProviderDraft(key, "d1");
    store.closeDraft(first!);
    const firstAgain = await store.editProviderDraft(key, "d1");
    store.editDraft(firstAgain!, { subject: "x" });
    const again = await store.editProviderDraft(key, "d1");
    expect(again).toBe(firstAgain);
    expect(Object.keys(store.getSnapshot().drafts)).toHaveLength(1);
  });

  it("refuses a message that is not a draft", async () => {
    const { store } = await setup();
    expect(await store.editProviderDraft(key, "m1")).toBeNull();
    expect(store.getSnapshot().error?.message).toBe("That message is not a draft.");
  });
});
