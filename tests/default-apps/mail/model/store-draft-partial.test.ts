/**
 * A provider save that fails after storing the draft reports the new id. The
 * store keeps it, so the next save updates that draft instead of making a copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailStore } from "../../../../home/apps/mail/src/model/store";
import { noMailCache } from "../../../../home/apps/mail/src/model/cache";
import { DraftPartiallySavedError, type Draft } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { GMAIL, GMAIL_FOLDERS, message, summary, thread } from "./fixtures";
import { FakeProvider, deferred } from "./fake-provider";

const quiet = () => undefined;
const AUTOSAVE = 1000;

async function setup() {
  const provider = new FakeProvider(GMAIL_FOLDERS);
  provider.lists.INBOX = [summary("t1")];
  provider.threads.t1 = thread("t1", [message("m1")]);
  const store = createMailStore({ accounts: [{ account: GMAIL, provider }], cache: noMailCache, logger: quiet, timeZone: "UTC", autosaveMs: AUTOSAVE });
  await store.start();
  return { store, provider };
}

const file = { name: "a.txt", mimeType: "text/plain", size: 1, contentBase64: "YQ==" };

function failPartway(draft: Draft): never {
  throw new DraftPartiallySavedError("failed", { ...draft, id: "srv-partial", attachments: draft.attachments.map((a) => ({ ...a, id: "att-1" })) });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("partially saved drafts", () => {
  it("keeps the provider id and stored attachment ids from a failed autosave and updates that draft next", async () => {
    const { store, provider } = await setup();
    provider.onSaveDraft = async (draft) => failPartway(draft);
    const id = store.compose()!;
    store.editDraft(id, { to: [{ address: "bob@example.com" }], bodyText: "hello", attachments: [file] });
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    const failed = store.getSnapshot().drafts[id];
    expect(failed.draft.id).toBe("srv-partial");
    expect(failed.draft.attachments[0].id).toBe("att-1");
    expect(failed.error).not.toBeNull();
    expect(failed.savedRevision).toBeLessThan(failed.revision);

    provider.onSaveDraft = null;
    await store.saveDraft(id);
    expect(provider.calls.saveDraft.at(-1)).toMatchObject({ id: "srv-partial", attachments: [{ id: "att-1" }] });
    expect(store.getSnapshot().drafts[id]).toMatchObject({ error: null, draft: { id: "srv-partial" } });
  });

  it("keeps the id when the save before a send fails partway, and sends that draft on the next click", async () => {
    const { store, provider } = await setup();
    provider.onSaveDraft = async (draft) => failPartway(draft);
    const id = store.compose()!;
    store.editDraft(id, { to: [{ address: "bob@example.com" }], bodyText: "hello" });
    expect(await store.sendDraft(id)).toBe(false);
    expect(store.getSnapshot().drafts[id].draft.id).toBe("srv-partial");
    expect(provider.calls.sendDraft).toEqual([]);

    provider.onSaveDraft = null;
    expect(await store.sendDraft(id)).toBe(true);
    expect(provider.calls.saveDraft.at(-1)?.id).toBe("srv-partial");
    expect(provider.calls.sendDraft).toEqual(["srv-partial"]);
  });

  it("deletes the partial provider copy when the owner discarded the draft during the save", async () => {
    const { store, provider } = await setup();
    const slow = deferred<Draft>();
    provider.onSaveDraft = () => slow.promise;
    const id = store.compose()!;
    store.editDraft(id, { subject: "x" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE);
    await store.discardDraft(id);
    slow.reject(new DraftPartiallySavedError("failed", { ...provider.calls.saveDraft[0], id: "srv-partial" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls.deleteDraft).toEqual(["srv-partial"]);
  });
});
