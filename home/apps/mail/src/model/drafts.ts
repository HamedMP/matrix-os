/**
 * Building replies and forwards from a thread: recipients, subject, threading
 * ids and the quoted original.
 *
 * The quote is made from the plain-text body only and escaped with
 * `textToHtml`, so provider HTML never reaches a draft. It is kept apart from
 * the owner's text (`DraftState.quote`) and joined by `composeDraft` at save
 * and send time.
 */
import {
  emptyDraft,
  formatMailAddress,
  normalizeMailAddress,
  sameMailAddress,
  type Draft,
  type IsoInstant,
  type MailAccount,
  type MailAddress,
  type MailMessage,
  type MailThread,
} from "../../../_shared/office-accounts/types/mail";
import { stripControl, textToHtml } from "../../../_shared/office-accounts/mail/text";
import type { DraftKind, DraftQuote, DraftState, ReplyMeta } from "./types";

/** Quoted original text kept in a draft, in characters; the draft request budget is 60 kB. */
export const MAX_QUOTED_CHARS = 16_000;

export function replySubject(subject: string): string {
  const clean = cleanSubject(subject);
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

export function forwardSubject(subject: string): string {
  const clean = cleanSubject(subject);
  return /^(fwd?|fw):/i.test(clean) ? clean : `Fwd: ${clean}`;
}

function cleanSubject(subject: string): string {
  return stripControl(subject.replace(/[\r\n]+/g, " ")).replace(/\s+/g, " ").trim();
}

function formatDate(instant: IsoInstant, timeZone: string): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return instant;
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(ms);
  } catch (error: unknown) {
    if (error instanceof RangeError) return new Date(ms).toUTCString();
    throw error;
  }
}

function capped(text: string): string {
  return text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}\n[…]` : text;
}

function quoteReply(message: MailMessage, timeZone: string): DraftQuote {
  const header = `On ${formatDate(message.sentAt, timeZone)}, ${formatMailAddress(message.from)} wrote:`;
  const body = capped(message.bodyText.replace(/\r\n?/g, "\n"));
  const quoted = body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
  return {
    text: `${header}\n${quoted}`,
    html: `<div>${textToHtml(header)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(body)}</blockquote>`,
  };
}

function quoteForward(message: MailMessage, timeZone: string): DraftQuote {
  const list = (addresses: MailAddress[]) => addresses.map(formatMailAddress).join(", ");
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${formatMailAddress(message.from)}`,
    `Date: ${formatDate(message.sentAt, timeZone)}`,
    `Subject: ${cleanSubject(message.subject)}`,
    `To: ${list(message.to)}`,
    ...(message.cc.length ? [`Cc: ${list(message.cc)}`] : []),
  ];
  const header = lines.join("\n");
  const body = capped(message.bodyText.replace(/\r\n?/g, "\n"));
  return { text: `${header}\n\n${body}`, html: `<div>${textToHtml(header)}</div><br><div>${textToHtml(body)}</div>` };
}

function withoutOwner(addresses: readonly MailAddress[], owner: MailAccount, exclude: ReadonlySet<string> = new Set()): MailAddress[] {
  const seen = new Set(exclude);
  const result: MailAddress[] = [];
  for (const entry of addresses) {
    const address = normalizeMailAddress(entry.address);
    if (!address || seen.has(address) || sameMailAddress(address, owner.address)) continue;
    seen.add(address);
    result.push(entry.name ? { name: entry.name, address } : { address });
  }
  return result;
}

/** The message to answer: the given one, else the last message that is not an unsent draft. */
function targetMessage(thread: MailThread, messageId: string | undefined): MailMessage | undefined {
  if (messageId) return thread.messages.find((message) => message.id === messageId);
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) if (!thread.messages[i].draftId) return thread.messages[i];
  return undefined;
}

export interface BuildDraftOptions {
  /** The account the draft is written from. */
  owner: MailAccount;
  /** The owner's zone for the date in the quote header. */
  timeZone: string;
  /** The message to answer; defaults to the last sent message. */
  messageId?: string;
}

export interface BuiltDraft {
  draft: Draft;
  quote: DraftQuote | null;
}

/** A new reply, reply-all or forward draft. Throws `RangeError` when the thread has no message to answer. */
export function buildDraftFromThread(kind: Exclude<DraftKind, "new">, thread: MailThread, options: BuildDraftOptions): BuiltDraft {
  const message = targetMessage(thread, options.messageId);
  if (!message) throw new RangeError("No message to answer");
  const draft = emptyDraft();
  if (kind === "forward") {
    return { draft: { ...draft, subject: forwardSubject(message.subject || thread.subject) }, quote: quoteForward(message, options.timeZone) };
  }
  const fromOwner = sameMailAddress(message.from.address, options.owner.address);
  let to: MailAddress[];
  let cc: MailAddress[] = [];
  if (kind === "reply") {
    to = fromOwner ? withoutOwner(message.to, options.owner) : withoutOwner([message.from], options.owner);
  } else {
    to = withoutOwner(fromOwner ? message.to : [message.from, ...message.to], options.owner);
    cc = withoutOwner(message.cc, options.owner, new Set(to.map((entry) => entry.address)));
  }
  return {
    draft: {
      ...draft,
      to,
      cc,
      subject: replySubject(message.subject || thread.subject),
      threadId: thread.id,
      inReplyToMessageId: message.id,
    },
    quote: quoteReply(message, options.timeZone),
  };
}

/** The draft as saved and sent: the owner's text followed by the quote. */
export function composeDraft(state: Pick<DraftState, "draft" | "quote">): Draft {
  const { draft, quote } = state;
  if (!quote) return draft;
  const ownHtml = draft.bodyHtml || (draft.bodyText ? `<div>${textToHtml(draft.bodyText)}</div>` : "");
  return {
    ...draft,
    bodyText: draft.bodyText ? `${draft.bodyText}\n\n${quote.text}` : quote.text,
    bodyHtml: ownHtml ? `${ownHtml}<br>${quote.html}` : quote.html,
  };
}

/** Who wrote last in a full thread, for the "waiting on" lists. */
export function replyMetaFromThread(thread: MailThread, owner: MailAccount): ReplyMeta | null {
  const last = targetMessage(thread, undefined);
  if (!last) return null;
  const lastFrom = normalizeMailAddress(last.from.address);
  return { lastFrom, lastAt: last.sentAt, ownerSentLast: sameMailAddress(lastFrom, owner.address) };
}
