import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailStore } from "../../../../home/apps/mail/src/model/store";
import { noMailCache } from "../../../../home/apps/mail/src/model/cache";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { MAX_OPEN_DRAFTS } from "../../../../home/apps/mail/src/model/store-drafts";
import type { Draft } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { GMAIL, GMAIL_FOLDERS, message, summary, thread } from "./fixtures";
import { FakeProvider, deferred } from "./fake-provider";

const quiet = () => undefined;
const AUTOSAVE = 1000;
const k = (id: string) => threadKey(GMAIL.id, id);

async function setup() {
  const gmail = new FakeProvider(GMAIL_FOLDERS);
  gmail.lists.INBOX = [summary("t1")];
  gmail.threads.t1 = thread("t1", [message("m1", { from: { name: "Alice", address: "alice@example.com" } })]);
  const store = createMailStore({ accounts: [{ account: GMAIL, provider: gmail }], cache: noMailCache, logger: quiet, timeZone: "UTC", autosaveMs: AUTOSAVE });
  await store.start();
  return { store, gmail };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("autosave", () => {
  it("saves once after the owner stops typing", async () => {
    const { store, gmail } = await setup();
    const id = store.compose()!;
    store.editDraft(id, { subject: "H" });
    await vi.advanceTimersByTimeAsync(500);
    store.editDraft(id, { subject: "Hello" });
    await vi.advanceTimersByTimeAsync(900);
    expect(gmail.calls.saveDraft).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(gmail.calls.saveDraft).toHaveLength(1);
    expect(gmail.calls.saveDraft[0].subject).toBe("Hello");
    const draft = store.getSnapshot().drafts[id];
    expect(draft).toMatchObject({ savedRevision: 2, revision: 2, saving: false });
    expect(draft.draft.id).toBe("draft-1");
  });

  it("never overwrites newer local edits with a slow save, and saves them next with the provider id", async () => {
    const { store, gmail } = await setup();
    const first = deferred<Draft>();
    gmail.onSaveDraft = () => first.promise;
    const id = store.compose()!;
    store.editDraft(id, { bodyText: "one" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    expect(store.getSnapshot().drafts[id].saving).toBe(true);
    store.editDraft(id, { bodyText: "one two" });
    gmail.onSaveDraft = null;
    first.resolve({ ...gmail.calls.saveDraft[0], id: "srv-1", bodyText: "one" });
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = store.getSnapshot().drafts[id];
    expect(afterFirst.draft.bodyText).toBe("one two");
    expect(afterFirst.draft.id).toBe("srv-1");
    expect(afterFirst.savedRevision).toBe(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    expect(gmail.calls.saveDraft).toHaveLength(2);
    expect(gmail.calls.saveDraft[1]).toMatchObject({ id: "srv-1", bodyText: "one two" });
  });

  it("flushes a closed draft without reopening it, then forgets it", async () => {
    const { store, gmail } = await setup();
    const slow = deferred<Draft>();
    gmail.onSaveDraft = () => slow.promise;
    const id = store.compose()!;
    store.editDraft(id, { subject: "Draft" });
    store.closeDraft(id);
    expect(store.getSnapshot().activeDraftId).toBeNull();
    expect(store.getSnapshot().drafts[id].open).toBe(false);
    expect(gmail.calls.saveDraft).toHaveLength(1);
    slow.resolve({ ...gmail.calls.saveDraft[0], id: "srv-9" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE * 2);
    expect(store.getSnapshot().drafts[id]).toBeUndefined();
    expect(store.getSnapshot().activeDraftId).toBeNull();
  });

  it("keeps a closed draft whose save failed, closed, with a safe error and no retry loop", async () => {
    const { store, gmail } = await setup();
    gmail.onSaveDraft = () => Promise.reject(new Error("quota for me@example.com"));
    const id = store.compose()!;
    store.editDraft(id, { subject: "x" });
    store.closeDraft(id);
    await vi.advanceTimersByTimeAsync(AUTOSAVE * 5);
    const draft = store.getSnapshot().drafts[id];
    expect(draft.open).toBe(false);
    expect(draft.error?.code).toBe("failed");
    expect(gmail.calls.saveDraft).toHaveLength(1);
  });

  it("deletes the provider copy when the owner discards during the first save", async () => {
    const { store, gmail } = await setup();
    const slow = deferred<Draft>();
    gmail.onSaveDraft = () => slow.promise;
    const id = store.compose()!;
    store.editDraft(id, { subject: "oops" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    await store.discardDraft(id);
    slow.resolve({ ...gmail.calls.saveDraft[0], id: "srv-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(gmail.calls.deleteDraft).toEqual(["srv-2"]);
    expect(store.getSnapshot().drafts[id]).toBeUndefined();
  });

  it("does not save a draft the provider would reject", async () => {
    const { store, gmail } = await setup();
    const id = store.compose()!;
    store.editDraft(id, { to: [{ address: "not an address" }] });
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    expect(gmail.calls.saveDraft).toHaveLength(0);
    expect(store.getSnapshot().drafts[id].issues).toEqual(["invalid_address"]);
  });
});

describe("replies and sending", () => {
  it("builds a reply from the open thread with the quote appended on save", async () => {
    const { store, gmail } = await setup();
    await store.openThread(k("t1"));
    const id = (await store.respond("reply"))!;
    const draft = store.getSnapshot().drafts[id];
    expect(draft).toMatchObject({ kind: "reply", sourceThreadKey: k("t1") });
    expect(draft.draft.to).toEqual([{ name: "Alice", address: "alice@example.com" }]);
    store.editDraft(id, { bodyText: "Thanks!" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    const saved = gmail.calls.saveDraft[0];
    expect(saved.threadId).toBe("t1");
    expect(saved.inReplyToMessageId).toBe("m1");
    expect(saved.bodyText.startsWith("Thanks!\n\nOn ")).toBe(true);
    expect(saved.bodyHtml).toContain("&lt;soon&gt;");
  });

  it("sends a stored draft once, after saving the latest edits", async () => {
    const { store, gmail } = await setup();
    const id = store.compose()!;
    store.editDraft(id, { to: [{ address: "bob@example.com" }], subject: "Hi", bodyText: "Hello" });
    expect(await store.sendDraft(id)).toBe(true);
    expect(gmail.calls.saveDraft).toHaveLength(1);
    expect(gmail.calls.sendDraft).toEqual(["draft-1"]);
    expect(store.getSnapshot().drafts[id]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(AUTOSAVE * 2);
    expect(gmail.calls.saveDraft).toHaveLength(1);
  });

  it("refuses to send without recipients and never retries a failed send", async () => {
    const { store, gmail } = await setup();
    const id = store.compose()!;
    store.editDraft(id, { subject: "No one" });
    expect(await store.sendDraft(id)).toBe(false);
    expect(store.getSnapshot().drafts[id].error?.code).toBe("draft_invalid");
    expect(gmail.calls.sendDraft).toEqual([]);
    store.editDraft(id, { to: [{ address: "bob@example.com" }] });
    gmail.onSendDraft = () => Promise.reject(new Error("smtp relay 10.0.0.4 refused"));
    expect(await store.sendDraft(id)).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE * 3);
    expect(gmail.calls.sendDraft).toHaveLength(1);
    const draft = store.getSnapshot().drafts[id];
    expect(draft).toMatchObject({ sending: false, error: { code: "failed" } });
    expect(draft.error?.message).not.toContain("10.0.0.4");
  });

  it("caps the number of open drafts", async () => {
    const { store } = await setup();
    for (let i = 0; i < MAX_OPEN_DRAFTS; i += 1) expect(store.compose()).not.toBeNull();
    expect(store.compose()).toBeNull();
    expect(store.getSnapshot().error?.code).toBe("too_many_drafts");
  });
});
