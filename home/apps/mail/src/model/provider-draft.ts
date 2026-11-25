/**
 * Opening a draft the provider stores (one shown inside a conversation or in
 * the Drafts folder) for editing again.
 *
 * The draft keeps its provider id, so saving updates it instead of creating a
 * copy. Its body is taken as the editor HTML the caller made from the
 * provider's HTML with the composer's paste sanitiser, or else as escaped
 * plain text: provider HTML never goes into a draft as is.
 */
import { emptyDraft, type Draft, type DraftAttachment, type MailMessage, type MailThread } from "../../../_shared/office-accounts/types/mail";
import { textToHtml } from "../../../_shared/office-accounts/mail/text";
import type { DraftKind } from "./types";

export interface ProviderDraftOptions {
  /** Editor-safe HTML made from the provider's HTML; escaped `bodyText` is used without it. */
  bodyHtml?: string;
  attachments: DraftAttachment[];
}

/** The last sent (non-draft) message before `index`, which a reply draft answers. */
function answeredMessage(thread: MailThread, index: number): MailMessage | undefined {
  for (let i = index - 1; i >= 0; i -= 1) if (!thread.messages[i].draftId) return thread.messages[i];
  return undefined;
}

/** A draft state body for the stored draft `message` of `thread`. Throws `RangeError` when it is not a draft. */
export function draftFromProviderMessage(thread: MailThread, message: MailMessage, options: ProviderDraftOptions): { draft: Draft; kind: DraftKind } {
  if (!message.draftId) throw new RangeError("Not a draft");
  const answered = answeredMessage(thread, thread.messages.indexOf(message));
  const bodyText = message.bodyText.replace(/\r\n?/g, "\n");
  const draft: Draft = {
    ...emptyDraft(),
    id: message.draftId,
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
    subject: message.subject,
    bodyHtml: options.bodyHtml ?? (bodyText ? `<div>${textToHtml(bodyText)}</div>` : ""),
    bodyText,
    attachments: options.attachments,
    ...(answered ? { threadId: thread.id, inReplyToMessageId: answered.id } : {}),
  };
  return { draft, kind: answered ? "reply" : "new" };
}
