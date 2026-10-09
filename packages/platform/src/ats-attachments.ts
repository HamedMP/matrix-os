import { z } from 'zod/v4';
import type { AtsDB } from './ats-db.js';

export const AtsAttachmentSchema = z.object({
  filename: z.string().min(1).max(180).transform((name) => name.replace(/[^a-zA-Z0-9._ -]/g, '_')),
  contentType: z.enum(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  base64: z.string().min(1).max(7 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).refine((file) => {
  const bytes = Buffer.from(file.base64, 'base64');
  if (bytes.toString('base64') !== file.base64 || !bytes.length || bytes.length > 5 * 1024 * 1024) return false;
  if (file.contentType === 'application/pdf') return bytes.subarray(0, 4).toString() === '%PDF';
  if (file.contentType === 'application/msword') return bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}, 'Invalid attachment');

export async function getAtsMailAttachment(db: AtsDB, id: string) {
  await db.ready;
  return db.executor.selectFrom('ats_mail_attachments')
    .innerJoin('ats_inbox_messages', 'ats_inbox_messages.id', 'ats_mail_attachments.message_id')
    .select(['ats_mail_attachments.id', 'filename', 'content_type', 'bytes'])
    .where('ats_mail_attachments.id', '=', id)
    .where((eb) => eb.or([
      eb('application_id', 'is', null),
      eb.exists(eb.selectFrom('ats_applications').select('id').whereRef('ats_applications.id', '=', 'ats_inbox_messages.application_id').where('deleted_at', 'is', null)),
    ])).executeTakeFirst();
}
