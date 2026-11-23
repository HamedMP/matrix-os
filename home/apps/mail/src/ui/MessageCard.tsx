/**
 * One message of a conversation. Collapsed it is a one-line summary; expanded
 * it shows the header, a recipients disclosure, the sanitised body and the
 * attachments.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Avatar } from "../../../_shared/office-ui";
import { formatMailAddress, type MailAddress, type MailMessage, type MailProvider } from "../../../_shared/office-accounts/types/mail";
import { attachmentToDataUrl, inlineImageRefs, MessageBody, type InlineImageSource } from "../html";
import { AttachmentChips } from "./AttachmentChips";
import { useMailUi } from "./context";
import { displayName, formatFullTime, formatListTime } from "./format";

/** At most this many inline images are fetched for one message. */
const MAX_INLINE_FETCHES = 12;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Fetches the inline attachments a message body refers to, as data URLs. */
function useInlineImages(provider: MailProvider | undefined, message: MailMessage, enabled: boolean): readonly InlineImageSource[] {
  const [images, setImages] = useState<readonly InlineImageSource[]>([]);
  const wanted = useMemo(() => {
    if (!enabled || !message.bodyHtml) return [];
    const refs = inlineImageRefs(message.bodyHtml);
    if (refs.length === 0) return [];
    return message.attachments.filter((attachment) => attachment.inline && attachment.mimeType.startsWith("image/")).slice(0, MAX_INLINE_FETCHES);
  }, [enabled, message.bodyHtml, message.attachments]);

  useEffect(() => {
    if (!provider || wanted.length === 0) return undefined;
    let live = true;
    void Promise.allSettled(wanted.map(async (attachment) => {
      const content = await provider.getAttachment(message.id, attachment.id);
      const dataUrl = attachmentToDataUrl(content);
      const contentId = attachment.contentId ?? content.contentId;
      return dataUrl ? { name: attachment.name, ...(contentId ? { contentId } : {}), dataUrl } : null;
    })).then((results) => {
      if (!live) return;
      const found: InlineImageSource[] = [];
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) found.push(result.value);
        else if (result.status === "rejected") console.warn(`[mail] inline.fetch.failed (${errorName(result.reason)})`);
      }
      setImages(found);
    });
    return () => {
      live = false;
    };
  }, [provider, wanted, message.id]);
  return images;
}

function recipientSummary(message: MailMessage, ownAddresses: readonly string[]): string {
  const own = new Set(ownAddresses);
  const names = [...message.to, ...message.cc].map((person: MailAddress) =>
    own.has(person.address.toLowerCase()) ? "me" : displayName(person));
  if (names.length === 0) return "to undisclosed recipients";
  return `to ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

function RecipientRow({ label, people }: { label: string; people: readonly MailAddress[] }) {
  if (people.length === 0) return null;
  return (
    <div className="mail-recipients__row">
      <dt>{label}</dt>
      <dd>{people.map(formatMailAddress).join(", ")}</dd>
    </div>
  );
}

export interface MessageCardProps {
  message: MailMessage;
  provider: MailProvider | undefined;
  expanded: boolean;
  onToggle: () => void;
}

export function MessageCard({ message, provider, expanded, onToggle }: MessageCardProps) {
  const { timeZone, now, ownAddresses } = useMailUi();
  const [showRecipients, setShowRecipients] = useState(false);
  const inlineImages = useInlineImages(provider, message, expanded);
  const sender = displayName(message.from);
  const preview = message.bodyText.replace(/\s+/g, " ").trim().slice(0, 200);

  if (!expanded) {
    return (
      <article className="mail-message is-collapsed" aria-label={`Message from ${sender}`}>
        <button type="button" className="mail-message__collapsed" aria-expanded={false} onClick={onToggle}>
          <Avatar name={sender} size={24} />
          <span className="mail-message__from">{sender}</span>
          <span className="mail-message__preview">{preview}</span>
          <time className="mail-message__time" dateTime={message.sentAt}>{formatListTime(message.sentAt, now(), timeZone)}</time>
        </button>
      </article>
    );
  }

  return (
    <article className="mail-message" aria-label={`Message from ${sender}`}>
      <header className="mail-message__header">
        <Avatar name={sender} size={32} />
        <div className="mail-message__meta">
          <div className="mail-message__line">
            <button type="button" className="mail-message__from-button" aria-expanded onClick={onToggle} title="Collapse message">
              <span className="mail-message__from">{sender}</span>
            </button>
            {message.from.name && <span className="mail-message__address">{message.from.address}</span>}
            <time className="mail-message__time" dateTime={message.sentAt}>{formatFullTime(message.sentAt, timeZone)}</time>
          </div>
          <button
            type="button"
            className="mail-recipients__toggle"
            aria-expanded={showRecipients}
            onClick={() => setShowRecipients((open) => !open)}
          >
            {showRecipients ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {recipientSummary(message, ownAddresses)}
          </button>
          {showRecipients && (
            <dl className="mail-recipients">
              <RecipientRow label="From" people={[message.from]} />
              <RecipientRow label="To" people={message.to} />
              <RecipientRow label="Cc" people={message.cc} />
              <RecipientRow label="Bcc" people={message.bcc} />
            </dl>
          )}
        </div>
      </header>
      <MessageBody
        html={message.bodyHtml}
        text={message.bodyText}
        messageKey={message.id}
        inlineImages={inlineImages}
        title={`Message from ${sender}`}
        className="mail-message__body"
      />
      <AttachmentChips provider={provider} messageId={message.id} attachments={message.attachments} />
    </article>
  );
}
