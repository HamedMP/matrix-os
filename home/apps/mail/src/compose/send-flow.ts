/**
 * The one path from the composer to `sendDraft`: an explicit owner action,
 * then a save that must succeed, then the send. A failure leaves the draft
 * open with the store's safe error; nothing is retried.
 */
import type { MailStore } from "../model";
import { isExplicitSend, type SendTrigger } from "./send-plan";

export type SendOutcome = "sent" | "failed" | "refused";

type SendStore = Pick<MailStore, "saveDraft" | "sendDraft" | "getSnapshot">;

export async function sendComposedDraft(store: SendStore, localId: string, trigger: SendTrigger): Promise<SendOutcome> {
  if (!isExplicitSend(trigger)) return "refused";
  const before = store.getSnapshot().drafts[localId];
  if (!before || before.sending) return "refused";
  await store.saveDraft(localId);
  const saved = store.getSnapshot().drafts[localId];
  if (!saved || saved.error || saved.saving) return "failed";
  return (await store.sendDraft(localId)) ? "sent" : "failed";
}
