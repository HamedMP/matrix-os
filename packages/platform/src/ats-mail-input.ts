import { z } from 'zod/v4';
import { AtsEmailAttachmentSchema } from './ats-attachments.js';

export const AtsMailSchema = z.object({
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), threadId: z.string().max(128),
  senderName: z.string().trim().max(200), senderEmail: z.email().max(320).transform((v) => v.toLowerCase()),
  subject: z.string().max(500), body: z.string().max(500_000), receivedAt: z.iso.datetime(),
  sourceUrl: z.string().max(2048).url().refine((v) => ['https://mail.google.com', 'https://groups.google.com'].includes(new URL(v).origin)),
  category: z.enum(['needs_review', 'candidate', 'moderation', 'vendor']).default('needs_review'),
  attachments: z.array(AtsEmailAttachmentSchema).max(30).default([]).refine((files) => files.reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0) <= 20 * 1024 * 1024),
});
export type AtsMailInput = z.input<typeof AtsMailSchema>;
// Only the authenticated, silent history-import path accepts an absent historical sender.
export const LegacyInboxSchema = AtsMailSchema.extend({ senderEmail: z.union([AtsMailSchema.shape.senderEmail, z.literal('')]) });
