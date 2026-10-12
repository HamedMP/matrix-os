import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';
import { AtsMailSchema } from './ats-mail-input.js';

export const MAX_RAW_MAIL_BYTES = 32 * 1024 * 1024;
export function isCareersGroup(listId: string | null) {
  return !!listId && /(?:^|<)careers\.finna\.ai(?:>|$)/i.test(listId.trim());
}
export async function normalizeGroupMail(raw: Uint8Array, receivedAt: string, archiveSourceUrl?: string) {
  if (archiveSourceUrl && !/^https:\/\/groups\.google\.com\/a\/finna\.ai\/g\/careers\/c\/[a-zA-Z0-9_-]+$/.test(archiveSourceUrl)) throw new Error('Unexpected archive source');
  if (raw.byteLength > MAX_RAW_MAIL_BYTES) throw new Error('Email exceeds intake limit');
  const mail = await PostalMime.parse(raw, { attachmentEncoding: 'base64', maxNestingDepth: 10, maxHeadersSize: 64 * 1024 });
  if (!archiveSourceUrl && !isCareersGroup(mail.headers.find((header) => header.key === 'list-id')?.value ?? null)) throw new Error('Unexpected email group');
  const sender = mail.from;
  if (!sender?.address) throw new Error('Missing applicant address');
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const declaredAttachments = mail.attachments.map((file) => ({
    filename: (file.filename || 'attachment').slice(0, 180), contentType: file.mimeType || 'application/octet-stream',
    base64: typeof file.content === 'string' ? file.content : Buffer.from(file.content).toString('base64'),
  }));
  const emptyAttachments = declaredAttachments.filter((file) => !file.base64.length);
  const attachments = declaredAttachments.filter((file) => file.base64.length > 0);
  // Preserve the actual HTML too: text extraction never substitutes a link for the body.
  if (mail.html) attachments.push({filename:'original-message.html',contentType:'text/html',base64:Buffer.from(mail.html).toString('base64')});
  // Empty MIME parts have no file bytes to retain. Report them in the body;
  // copying the entire source here would duplicate valid files and exceed
  // their allowance. The original stays available at the Group source URL.
  const originalBody = mail.text ?? (mail.html ? htmlMailText(mail.html) : '');
  const body = originalBody + emptyAttachments.map((file) => `\n\nAttachment unavailable: ${(file.filename || 'attachment').slice(0, 180)} (the original email contains no file bytes).`).join('');
  const parentId = mail.references?.match(/<[^>]+>/)?.[0] || mail.inReplyTo;
  return AtsMailSchema.parse({
    messageId: hash(mail.messageId || raw), threadId: parentId ? hash(parentId) : '',
    senderName: sender.name.slice(0, 200), senderEmail: sender.address,
    subject: (mail.subject || '(No subject)').slice(0, 500), body,
    receivedAt: archiveSourceUrl && mail.date && !Number.isNaN(Date.parse(mail.date)) ? new Date(mail.date).toISOString() : receivedAt, sourceUrl: archiveSourceUrl || 'https://groups.google.com/a/finna.ai/g/careers', attachments,
  });
}

function htmlMailText(html:string){
 return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<(?:br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')
  .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,code:string)=>{const point=code.toLowerCase().startsWith('x')?parseInt(code.slice(1),16):parseInt(code,10);return point<=0x10ffff?String.fromCodePoint(point):'�';})
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,name:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name]||''));
}
