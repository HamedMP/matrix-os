/**
 * A thread as untrusted prompt blocks: the most recent messages, oldest
 * first, each with its own text (quoted history removed, since earlier
 * messages are blocks of their own) and its attachment names.
 */
import {
  formatMailAddress,
  sameMailAddress,
  type MailAccount,
  type MailAddress,
  type MailMessage,
  type MailThread,
} from "../../../_shared/office-accounts/types/mail";
import { MAX_ATTACHMENT_NAMES, MAX_MESSAGE_CHARS, MAX_THREAD_MESSAGES } from "./limits";
import type { PromptBlock } from "./prompt";
import { clip, oneLineText } from "./untrusted";
import { ownText } from "./voice-derive";

function addresses(list: readonly MailAddress[]): string {
  return list.slice(0, 10).map(formatMailAddress).join(", ") + (list.length > 10 ? ` and ${list.length - 10} more` : "");
}

/** Listed (not inline) attachment names of a message, one line each. */
export function attachmentNames(message: MailMessage): string[] {
  return message.attachments.filter((a) => !a.inline).map((a) => oneLineText(a.name, 120)).filter(Boolean);
}

/** Every listed attachment name in the thread, without duplicates, at most `MAX_ATTACHMENT_NAMES`. */
export function threadAttachmentNames(thread: MailThread): string[] {
  const seen = new Set<string>();
  for (const message of thread.messages) {
    for (const name of attachmentNames(message)) {
      seen.add(name);
      if (seen.size >= MAX_ATTACHMENT_NAMES) return [...seen];
    }
  }
  return [...seen];
}

/** The message text worth showing a model: own text, else the start of the body. */
export function messageText(message: MailMessage, max = MAX_MESSAGE_CHARS): string {
  const own = ownText(message.bodyText ?? "");
  return clip(own || (message.bodyText ?? "").trim(), max);
}

export function messageBlock(message: MailMessage, label: string, owner?: MailAccount, max = MAX_MESSAGE_CHARS): PromptBlock {
  const fromOwner = owner ? sameMailAddress(message.from.address, owner.address) : false;
  return {
    label: fromOwner ? `${label} (written by the owner)` : label,
    from: formatMailAddress(message.from),
    to: addresses([...message.to, ...message.cc]),
    date: message.sentAt,
    subject: message.subject,
    attachments: attachmentNames(message),
    text: messageText(message, max),
  };
}

/** The last `MAX_THREAD_MESSAGES` sent messages (drafts left out), oldest first. */
export function threadBlocks(thread: MailThread, owner?: MailAccount, max = MAX_MESSAGE_CHARS): PromptBlock[] {
  const sent = thread.messages.filter((message) => !message.draftId);
  const recent = sent.slice(-MAX_THREAD_MESSAGES);
  const skipped = sent.length - recent.length;
  return recent.map((message, i) => messageBlock(message, `Message ${skipped + i + 1} of ${sent.length}`, owner, max));
}

/** The message a reply answers: the last one that is not an unsent draft. */
export function lastSentMessage(thread: MailThread): MailMessage | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) if (!thread.messages[i].draftId) return thread.messages[i];
  return undefined;
}

/** Who a reply mainly goes to: the last sender, or the first recipient when the owner wrote last. */
export function replyRecipient(thread: MailThread, owner: MailAccount): string | null {
  const last = lastSentMessage(thread);
  if (!last) return null;
  if (!sameMailAddress(last.from.address, owner.address)) return last.from.address;
  return last.to.find((entry) => !sameMailAddress(entry.address, owner.address))?.address ?? null;
}
