import { describe, expect, it } from 'vitest';
import { whatsappEncryptionKey, hashWhatsAppSecret, compareWhatsAppSecret, hashWhatsAppCode, compareWhatsAppCode,
  encryptWhatsAppPayload, decryptWhatsAppPayload } from '../../packages/platform/src/whatsapp/crypto.js';

const key = Buffer.alloc(32, 7);
describe('WhatsApp encrypted delivery and sender proof', () => {
  it('accepts exact 256-bit keys and rejects truncated encryption configuration', () => {
    expect(whatsappEncryptionKey(key.toString('hex'))).toEqual(key);
    expect(whatsappEncryptionKey(key.toString('base64'))).toEqual(key);
    expect(() => whatsappEncryptionKey(Buffer.alloc(31))).toThrow('Invalid WhatsApp encryption configuration');
    expect(() => whatsappEncryptionKey('invalid-key')).toThrow('Invalid WhatsApp encryption configuration');
  });
  it('requires the exact proof and rejects malformed hashes without timing-comparison exceptions', () => {
    expect(compareWhatsAppSecret('token', hashWhatsAppSecret('token'))).toBe(true);
    expect(compareWhatsAppSecret('other', hashWhatsAppSecret('token'))).toBe(false);
    expect(compareWhatsAppSecret('token', 'bad')).toBe(false);
    expect(compareWhatsAppCode('123456', hashWhatsAppCode('123456', key), key)).toBe(true);
    expect(compareWhatsAppCode('654321', hashWhatsAppCode('123456', key), key)).toBe(false);
    expect(compareWhatsAppCode('123456', 'bad', key)).toBe(false);
  });
  it('authenticates ciphertext and rejects malformed envelopes, wrong keys, and oversized payloads', () => {
    const payload = { text: 'Owner message' };
    const encrypted = encryptWhatsAppPayload(payload, key);
    expect(decryptWhatsAppPayload(encrypted, key)).toEqual(payload);
    expect(encrypted).not.toContain(payload.text);
    expect(() => decryptWhatsAppPayload(encrypted, Buffer.alloc(32, 8))).toThrow();
    for (const malformed of ['garbage', 'v2.a.b.c', 'v1.a.b.c', `v1.${Buffer.alloc(12).toString('base64url')}.a.c`]) {
      expect(() => decryptWhatsAppPayload(malformed, key)).toThrow('Invalid encrypted WhatsApp payload');
    }
    expect(() => encryptWhatsAppPayload({ text: 'x'.repeat(65_536) }, key)).toThrow('WhatsApp payload is too large');
    for (const value of [null, [], 123]) {
      const invalid = encryptWhatsAppPayload(value as unknown as Record<string, unknown>, key);
      expect(() => decryptWhatsAppPayload(invalid, key)).toThrow('Invalid WhatsApp payload');
    }
  });
});
