import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod/v4';

/** Cursors are continuations, never authorization. Production always supplies its durable secret. */
export function encodeExportCursor(value: unknown, owner: string, purpose: string, secret?: string): string {
  const payload = Buffer.from(JSON.stringify({ owner, purpose, value })).toString('base64url');
let cursor = payload;
  if (secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('account-export:'+secret).digest(), iv);
    cipher.setAAD(Buffer.from(owner+':'+purpose));
    const encrypted = Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]);
    cursor = Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  }
  if (cursor.length > 4096) throw new Error('Export cursor capacity exceeded');
  return cursor;
}

export function decodeExportCursor<T>(cursor: string, owner: string, purpose: string,
  schema: z.ZodType<T>, secret?: string): T {
  z.string().min(1).max(4096).parse(cursor);
  let payload = cursor;
  if (secret) {
    const encrypted = Buffer.from(cursor,'base64url');
    if(encrypted.length<29)throw new Error('Invalid export cursor');
    const decipher = createDecipheriv('aes-256-gcm',createHash('sha256').update('account-export:'+secret).digest(),encrypted.subarray(0,12));
    decipher.setAAD(Buffer.from(owner+':'+purpose));
    decipher.setAuthTag(encrypted.subarray(12,28));
    payload=Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]).toString('utf8');
  }
  const envelope = z.object({ owner: z.literal(owner), purpose: z.literal(purpose), value: schema }).strict();
  return envelope.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).value;
}
