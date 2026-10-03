import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function whatsappEncryptionKey(key: Buffer | string): Buffer {
  const bytes = typeof key === 'string'
    ? Buffer.from(key, /^[a-f\d]{64}$/i.test(key) ? 'hex' : 'base64') : key;
  if (bytes.length !== 32) throw new Error('Invalid WhatsApp encryption configuration');
  return bytes;
}
export function hashWhatsAppSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
export function compareWhatsAppSecret(value: string, hash: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const received = Buffer.from(hashWhatsAppSecret(value), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
export function hashWhatsAppCode(code: string, key: Buffer | string): string {
  return createHmac('sha256', whatsappEncryptionKey(key)).update('whatsapp-proof-v1\0').update(code).digest('hex');
}
export function compareWhatsAppCode(code: string, hash: string, key: Buffer | string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const received = Buffer.from(hashWhatsAppCode(code, key), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
export function encryptWhatsAppPayload(value: Record<string, unknown>, key: Buffer | string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', whatsappEncryptionKey(key), iv);
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > 65_536) throw new Error('WhatsApp payload is too large');
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function decryptWhatsAppPayload(value: string, key: Buffer | string): Record<string, unknown> {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted WhatsApp payload');
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted WhatsApp payload');
  const decipher = createDecipheriv('aes-256-gcm', whatsappEncryptionKey(key), iv);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]);
  const result: unknown = JSON.parse(clear.toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid WhatsApp payload');
  return result as Record<string, unknown>;
}
