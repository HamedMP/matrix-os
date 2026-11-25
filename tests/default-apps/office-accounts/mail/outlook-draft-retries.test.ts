/**
 * Outlook draft saves take several calls. A failure after the first create must
 * not lose the new provider id, or every retry creates another orphan draft.
 */
import { describe, expect, it } from "vitest";
import { createOutlookProvider } from "../../../../home/apps/_shared/office-accounts/mail/outlook-provider";
import {
  DraftPartiallySavedError, emptyDraft, mailAccountId, partiallySavedDraft, type Draft, type MailAccount,
} from "../../../../home/apps/_shared/office-accounts/types/mail";
import { FakeBridge, b64, statusError } from "./fake-bridge";
import { writeEcho } from "./outlook-fixtures";

const SERVICE = "microsoft_outlook";
const ACCOUNT: MailAccount = { id: mailAccountId("outlook", "owner@contoso.com"), provider: "outlook", address: "owner@contoso.com", displayName: "Owner" };

function setup() {
  const bridge = new FakeBridge();
  const provider = createOutlookProvider({ account: ACCOUNT, label: "Contoso", bridge });
  return { bridge, provider };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(), to: [{ address: "grace@contoso.com" }], subject: "Budget", bodyHtml: "<p>Hi</p>", bodyText: "Hi", ...overrides };
}

const file = (name: string, text: string) => ({ name, mimeType: "text/plain", size: text.length, contentBase64: b64(text) });

/** Saves like the store does: keeps whatever id a partial failure reports. */
async function saveLikeStore(provider: ReturnType<typeof setup>["provider"], current: Draft): Promise<Draft> {
  try {
    return await provider.saveDraft(current);
  } catch (error: unknown) {
    const partial = partiallySavedDraft(error);
    if (!partial) throw error;
    return { ...current, id: partial.id, attachments: partial.attachments };
  }
}

describe("outlook draft saves that fail partway", () => {
  it("keeps the reply draft id when the follow-up update fails, and retries against it", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_reply_draft", writeEcho("draft-r1", { conversationId: "conv-A" }));
    bridge.fail(SERVICE, "update_draft", statusError(503));
    const reply = draft({ inReplyToMessageId: "msg-a2", subject: "RE: Budget", threadId: "conv-A" });

    const error = await provider.saveDraft(reply).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DraftPartiallySavedError);
    expect(error).toMatchObject({ code: "failed" });
    expect(partiallySavedDraft(error)).toMatchObject({ id: "draft-r1", threadId: "conv-A" });

    bridge.reply(SERVICE, "update_draft", writeEcho("draft-r1", { conversationId: "conv-A" }));
    const retried = await saveLikeStore(provider, { ...reply, id: "draft-r1" });
    expect(retried.id).toBe("draft-r1");
    expect(bridge.callsTo("create_reply_draft")).toHaveLength(1);
    expect(bridge.callsTo("update_draft").at(-1)?.params).toMatchObject({ messageId: "draft-r1", subject: "RE: Budget", bodyHtml: "<p>Hi</p>" });
  });

  it("keeps the new draft and the attachments stored so far when a later attachment fails", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_html_draft", writeEcho("draft-1"))
      .reply(SERVICE, "add_attachment", { id: "att-a" })
      .fail(SERVICE, "add_attachment", statusError(500));
    const first = draft({ attachments: [file("a.txt", "a"), file("b.txt", "b")] });

    const afterFailure = await saveLikeStore(provider, first);
    expect(afterFailure.id).toBe("draft-1");
    expect(afterFailure.attachments.map((a) => a.id)).toEqual(["att-a", undefined]);

    bridge.reply(SERVICE, "update_draft", writeEcho("draft-1")).reply(SERVICE, "add_attachment", { id: "att-b" });
    const saved = await saveLikeStore(provider, afterFailure);
    expect(saved).toMatchObject({ id: "draft-1", attachments: [{ id: "att-a" }, { id: "att-b" }] });
    expect(bridge.callsTo("create_html_draft")).toHaveLength(1);
    expect(bridge.callsTo("delete_draft")).toHaveLength(0);
    expect(bridge.callsTo("add_attachment").at(-1)?.params).toMatchObject({ messageId: "draft-1", name: "b.txt" });
  });

  it("returns the recreated draft when deleting the old one fails, and deletes it on the next save", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_attachments", { value: [{ id: "att-a" }, { id: "att-b" }] })
      .reply(SERVICE, "create_html_draft", writeEcho("draft-2"))
      .reply(SERVICE, "add_attachment", { id: "att-a2" })
      .fail(SERVICE, "delete_draft", statusError(503));
    const saved = await saveLikeStore(provider, draft({ id: "draft-1", attachments: [{ id: "att-a", ...file("a.txt", "a") }] }));
    expect(saved).toMatchObject({ id: "draft-2", attachments: [{ id: "att-a2" }] });

    bridge.reply(SERVICE, "delete_draft", writeEcho("draft-1")).reply(SERVICE, "update_draft", writeEcho("draft-2"));
    const again = await saveLikeStore(provider, { ...saved, subject: "Budget v2" });
    expect(again.id).toBe("draft-2");
    expect(bridge.callsTo("create_html_draft")).toHaveLength(1);
    expect(bridge.callsTo("delete_draft").map((call) => call.params)).toEqual([{ messageId: "draft-1" }, { messageId: "draft-1" }]);
    expect(bridge.pending()).toEqual([]);
  });

  it("queues the old draft for deletion when the recreated copy fails partway", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_attachments", { value: [{ id: "att-a" }, { id: "att-b" }] })
      .reply(SERVICE, "create_html_draft", writeEcho("draft-2"))
      .fail(SERVICE, "add_attachment", statusError(500));
    const afterFailure = await saveLikeStore(provider, draft({ id: "draft-1", attachments: [{ id: "att-a", ...file("a.txt", "a") }] }));
    expect(afterFailure.id).toBe("draft-2");
    expect(afterFailure.attachments[0]).toMatchObject({ name: "a.txt", contentBase64: b64("a") });
    expect(afterFailure.attachments[0].id).toBeUndefined();

    bridge.reply(SERVICE, "delete_draft", writeEcho("draft-1"))
      .reply(SERVICE, "update_draft", writeEcho("draft-2"))
      .reply(SERVICE, "add_attachment", { id: "att-a3" });
    const saved = await saveLikeStore(provider, afterFailure);
    expect(saved).toMatchObject({ id: "draft-2", attachments: [{ id: "att-a3" }] });
    expect(bridge.callsTo("create_html_draft")).toHaveLength(1);
    expect(bridge.callsTo("delete_draft").map((call) => call.params)).toEqual([{ messageId: "draft-1" }]);
  });
});
