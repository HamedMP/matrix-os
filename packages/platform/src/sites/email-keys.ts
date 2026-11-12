import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod/v4';
import { SiteError } from './types.js';

const ClerkIdSchema = z.string().regex(/^user_[A-Za-z0-9_-]{1,200}$/);
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,200}$/);

function keyedReference(purpose: string, value: string, secret: string): string {
  if (Buffer.byteLength(secret) < 32) throw new SiteError('unavailable');
  const key = createHash('sha256').update(`matrix-site-${purpose}\0`).update(secret).digest();
  return createHmac('sha256', key).update(value).digest('hex');
}
export function siteClerkSessionKey(sessionId: string, secret: string): string {
  return keyedReference('clerk-session', SessionIdSchema.parse(sessionId), secret);
}
export function siteRecipientKey(userId: string, secret: string): string {
  return keyedReference('recipient', ClerkIdSchema.parse(userId), secret);
}
