import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';
import { AtsMailSchema } from './ats-mail-input.js';

export const MAX_RAW_MAIL_BYTES = 8 * 1024 * 1024;
export function isCareersGroup(listId: string | null) {
  return !!listId && /(?:^|<)careers\.finna\.ai(?:>|$)/i.test(listId.trim());
}
export async function normalizeGroupMail(raw: Uint8Array, receivedAt: string) {
  if (raw.byteLength > MAX_RAW_MAIL_BYTES) throw new Error('Email exceeds intake limit');
  const mail = await PostalMime.parse(raw, { attachmentEncoding: 'base64', maxNestingDepth: 10, maxHeadersSize: 64 * 1024 });
  if (!isCareersGroup(mail.headers.find((header) => header.key === 'list-id')?.value ?? null)) throw new Error('Unexpected email group');
  const sender = mail.from;
  if (!sender?.address) throw new Error('Missing applicant address');
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const supported = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const attachments = mail.attachments.filter((file) => supported.includes(file.mimeType)).map((file) => ({
    filename: (file.filename || 'attachment').slice(0, 180), contentType: file.mimeType,
    base64: typeof file.content === 'string' ? file.content : Buffer.from(file.content).toString('base64'),
  }));
  const omitted = mail.attachments.filter((file) => !supported.includes(file.mimeType)).map((file) => (file.filename || 'unnamed').slice(0, 180));
  const body = mail.text ?? (mail.html ? 'This message contains HTML. Open the careers group to read the original message.' : '');
  const notice = omitted.length ? `\n\nAttachments available in the careers group: ${omitted.slice(0, 10).join(', ')}` : '';
  return AtsMailSchema.parse({
    messageId: hash(mail.messageId || raw), threadId: mail.inReplyTo ? hash(mail.inReplyTo) : '',
    senderName: sender.name.slice(0, 200), senderEmail: sender.address,
    subject: (mail.subject || '(No subject)').slice(0, 500), body: body.slice(0, 57_000) + notice,
    receivedAt, sourceUrl: 'https://groups.google.com/a/finna.ai/g/careers', attachments,
  });
}
