import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createStoreObjects, type AppStoreObjectStorage } from '../../packages/platform/src/app-store/object-store.js';
import { readStoreConfiguration } from '../../packages/platform/src/app-store/reviewer-allowlist.js';
const storage = (chunks: Uint8Array[], contentLength?: number) => ({
  getObject: vi.fn(async () => ({ body: new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), contentLength })),
  putObject: vi.fn(async () => ({})), deleteObject: vi.fn(async () => undefined),
  getPresignedGetUrl: vi.fn(async () => 'https://object.example/source'), getPresignedPutUrl: vi.fn(async () => 'https://object.example/upload'),
}) satisfies AppStoreObjectStorage;
describe('bounded source object transport', () => {
  it('rejects declared or streamed sizes that differ, and caps untrusted streams', async () => {
    await expect(createStoreObjects(storage([Buffer.from('abc')], 3)).read('key', 2)).rejects.toMatchObject({ code: 'invalid' });
    await expect(createStoreObjects(storage([Buffer.from('abc')])).read('key', 2)).rejects.toMatchObject({ code: 'invalid' });
    await expect(createStoreObjects(storage([Buffer.from('a')])).read('key', 2)).rejects.toMatchObject({ code: 'invalid' });
    await expect(createStoreObjects(storage([Buffer.alloc(16 * 1024 * 1024), Buffer.from('a')])).read('key')).rejects.toMatchObject({ code: 'invalid' });
  });
  it('uses short presigned expiry, size constrained uploads, and explicit read/write/delete deadlines', async () => {
    const fake = storage([Buffer.from('abc')], 3); const objects = createStoreObjects(fake);
    expect(await objects.read('key', 3)).toEqual(Buffer.from('abc'));
    expect(fake.getObject).toHaveBeenCalledWith('key', { signal: expect.any(AbortSignal) });
    await objects.upload('key', 3); expect(fake.getPresignedPutUrl).toHaveBeenCalledWith('key', 3, 900);
    await objects.download('key'); expect(fake.getPresignedGetUrl).toHaveBeenCalledWith('key', 900);
    await objects.write('key', Buffer.from('abc')); expect(fake.putObject).toHaveBeenCalledWith('key', Buffer.from('abc'), { signal: expect.any(AbortSignal), contentLength: 3 });
    await objects.delete('key'); expect(fake.deleteObject).toHaveBeenCalledWith('key', { signal: expect.any(AbortSignal) });
  });
  it('preserves operational storage failures rather than misreporting not found', async () => {
    const fake = storage([]); fake.getObject.mockRejectedValueOnce(new Error('unavailable'));
    await expect(createStoreObjects(fake).read('key')).rejects.toThrow('unavailable');
  });
});
describe('reviewer and source signing configuration', () => {
  it('bounds and validates the fixed reviewer allowlist', () => {
    const config = readStoreConfiguration({ MATRIX_APP_STORE_REVIEWER_CLERK_IDS: Array.from({ length: 150 }, (_, i) => `user_${i}`).join(',') + ', bad@id', MATRIX_APP_STORE_ENABLED: 'true' });
    expect(config.enabled).toBe(true); expect(config.reviewers).toHaveLength(100); expect(config.signingKeys).toEqual([]);
  });
  it('derives the public Ed25519 key without returning the private key', () => {
    const pair = generateKeyPairSync('ed25519'); const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const config = readStoreConfiguration({ MATRIX_APP_STORE_SIGNING_KEY_ID: 'v1', MATRIX_APP_STORE_SIGNING_PRIVATE_KEY: privateKey });
    expect(config.signingKeys).toEqual([{ keyId: 'v1', publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }]);
    expect(JSON.stringify(config.signingKeys)).not.toContain('PRIVATE KEY');
    expect(() => readStoreConfiguration({ MATRIX_APP_STORE_SIGNING_KEY_ID: 'v1' })).toThrow();
    expect(() => readStoreConfiguration({ MATRIX_APP_STORE_PREVIOUS_SIGNING_KEYS: JSON.stringify(Array.from({ length: 5 }, () => config.signingKeys[0])) })).toThrow();
    expect(() => readStoreConfiguration({ MATRIX_APP_STORE_SIGNING_KEY_ID: 'v1', MATRIX_APP_STORE_SIGNING_PRIVATE_KEY: privateKey, MATRIX_APP_STORE_PREVIOUS_SIGNING_KEYS: JSON.stringify(config.signingKeys) })).toThrow();
  });
});
