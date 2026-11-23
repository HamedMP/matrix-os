/**
 * Draft checks and field cleaning shared by both mail adapters.
 */
import {
  ProviderError, draftIssues,
  type Draft, type DraftAttachment, type DraftIssue, type MailAddress,
} from "../types/mail.js";
import { LruCache } from "./support.js";
import { base64UrlToBase64, htmlToText, stripControl, textToHtml } from "./text.js";

const ISSUE_MESSAGES: Readonly<Record<DraftIssue, string>> = {
  no_recipients: "Add at least one recipient.",
  invalid_address: "One of the addresses is not valid.",
  too_many_recipients: "This draft has too many recipients.",
  subject_too_long: "The subject is too long.",
  too_many_attachments: "This draft has too many attachments.",
  too_large: "This draft is too large. Remove an attachment or shorten the message.",
};

/** Rejects with `not_supported` and an owner-facing sentence when the draft cannot be saved. */
export function assertDraftSavable(draft: Draft): void {
  const issues = draftIssues(draft);
  if (issues.length > 0) throw new ProviderError("not_supported", ISSUE_MESSAGES[issues[0]]);
}

export interface WireRecipient {
  address: string;
  name?: string;
}

/** Recipients as the compose actions take them: `name` 1 to 128 characters without control characters. */
export function wireRecipients(list: readonly MailAddress[]): WireRecipient[] {
  return list.map(({ address, name }) => {
    const cleanName = stripControl(name ?? "").trim().slice(0, 128);
    return cleanName ? { address: address.trim(), name: cleanName } : { address: address.trim() };
  });
}

export function wireSubject(subject: string): string {
  return stripControl(subject).slice(0, 255);
}

/** The HTML body to store; plain text is escaped when the owner wrote no HTML. */
export function draftHtml(draft: Draft): string {
  if (draft.bodyHtml) return draft.bodyHtml;
  return draft.bodyText ? textToHtml(draft.bodyText) : "";
}

/** The plain-text body to store; derived from the HTML when the owner wrote none. */
export function draftText(draft: Draft): string {
  if (draft.bodyText) return draft.bodyText;
  return draft.bodyHtml ? htmlToText(draft.bodyHtml) : "";
}

const MIME_TYPE = /^[\w.+-]{1,63}\/[\w.+-]{1,63}$/;

export function wireFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[/\\"\u0000-\u001f\u007f]/g, "_").trim().slice(0, 255);
  return clean || "attachment";
}

export function wireMimeType(mimeType: string): string {
  return MIME_TYPE.test(mimeType) ? mimeType : "application/octet-stream";
}

export function wireBase64(content: string): string {
  try {
    return base64UrlToBase64(content.replace(/\s+/g, ""));
  } catch (error: unknown) {
    if (error instanceof RangeError) throw new ProviderError("not_supported", "One of the attachments could not be read.");
    throw error;
  }
}

let attachmentCounter = 0;

/** A new id for a draft attachment the adapter stores itself. */
export function newAttachmentId(): string {
  attachmentCounter = (attachmentCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `a${Date.now().toString(36)}${attachmentCounter.toString(36)}`;
}

/**
 * Remembers the content of attachments the adapter has saved, so a draft that
 * comes back with only attachment ids can still be saved again. Capped by
 * count and by total base64 length.
 */
export class AttachmentContentStore {
  private readonly cache = new LruCache<string, string>(40, 4_000_000, (content) => content.length);

  remember(draftId: string, attachmentId: string, contentBase64: string): void {
    this.cache.set(`${draftId}\u0000${attachmentId}`, contentBase64);
  }

  /** The content of an attachment: given on the draft, or remembered from an earlier save. */
  contentOf(draftId: string | undefined, attachment: DraftAttachment): string {
    if (attachment.contentBase64) return wireBase64(attachment.contentBase64);
    const remembered = draftId && attachment.id ? this.cache.get(`${draftId}\u0000${attachment.id}`) : undefined;
    if (remembered) return remembered;
    throw new ProviderError("not_supported", "Attach the file again before saving this draft.");
  }
}
