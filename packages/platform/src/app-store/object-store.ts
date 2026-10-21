import { Readable } from 'node:stream';
import { APP_STORE_MAX_SOURCE_BUNDLE_BYTES } from '@matrix-os/contracts/app-store';
import type { R2Client } from '../r2-client.js';
import { AppStoreError } from './errors.js';
export type AppStoreObjectStorage = Pick<R2Client, 'getObject' | 'putObject' | 'deleteObject' | 'getPresignedGetUrl' | 'getPresignedPutUrl'>;
export function createStoreObjects(storage: AppStoreObjectStorage) {
  async function read(key: string, expectedSize?: number): Promise<Buffer> {
    const signal = AbortSignal.timeout(30_000);
    const object = await storage.getObject(key, { signal });
    if (!object.body) throw new AppStoreError('invalid');
    if (object.contentLength !== undefined && (object.contentLength > APP_STORE_MAX_SOURCE_BUNDLE_BYTES || (expectedSize !== undefined && object.contentLength !== expectedSize))) {
      if (typeof object.body.cancel === 'function') await object.body.cancel().catch(error => console.warn('[app-store] Object cancellation failed', error));
      else (object.body as unknown as Readable).destroy?.();
      throw new AppStoreError('invalid');
    }
    const stream = Readable.from(object.body as unknown as AsyncIterable<Uint8Array>, { signal });
    const chunks: Buffer[] = []; // Per request: total cap 16MiB; released when read settles.
    let length = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > APP_STORE_MAX_SOURCE_BUNDLE_BYTES || (expectedSize !== undefined && length > expectedSize)) throw new AppStoreError('invalid');
        chunks.push(bytes);
      }
    } finally { stream.destroy(); }
    if (expectedSize !== undefined && length !== expectedSize) throw new AppStoreError('invalid');
    return Buffer.concat(chunks, length);
  }
  return {
    read,
    upload: (key: string, size: number) => storage.getPresignedPutUrl(key, size, 900),
    download: (key: string) => storage.getPresignedGetUrl(key, 900),
    write: (key: string, bytes: Buffer) => storage.putObject(key, bytes, { signal: AbortSignal.timeout(30_000), contentLength: bytes.length }),
    delete: (key: string) => storage.deleteObject(key, { signal: AbortSignal.timeout(30_000) }),
  };
}
export type StoreObjects = ReturnType<typeof createStoreObjects>;
