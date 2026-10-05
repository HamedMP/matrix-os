import { S3Client, ListObjectsV2Command, DeleteObjectCommand, ListMultipartUploadsCommand,
  AbortMultipartUploadCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod/v4';
import type { R2ClientConfig } from '../r2-client.js';

export interface AccountDeletionObjectStore {
  listObjects(prefix: string, cursor?: string): Promise<{ keys: string[]; nextCursor: string | null }>;
  deleteObject(key: string): Promise<void>;
  abortOwnerMultipartUploads(prefix: string): Promise<void>;
  getPresignedGetUrl?(key: string, expiresIn?: number): Promise<string>;
  destroy?(): void;
}
export function ownerStoragePrefixes(owner: string, root: string): string[] {
  z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/).parse(owner);
  z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).max(256).parse(root);
  return [...new Set(['matrixos-sync', root])].map((prefix) => `${prefix}/${owner}/`);
}
/** Delete bounded batches from the start. A crash safely restarts without an in-memory inventory. */
export async function eraseOwnerStorage(store: AccountDeletionObjectStore, owner: string, root: string): Promise<void> {
  for (const prefix of ownerStoragePrefixes(owner, root)) {
    await store.abortOwnerMultipartUploads(prefix);
    for (let batch = 0; batch < 100; batch++) {
      const page = await store.listObjects(prefix);
      if (page.keys.some((key) => !key.startsWith(prefix))) throw new Error('Storage ownership mismatch');
      if (!page.keys.length) {
        if (page.nextCursor) throw new Error('Storage inventory incomplete');
        break;
      }
      for (const key of page.keys) await store.deleteObject(key);
      if (batch === 99) throw new Error('Storage cleanup pending');
    }
  }
}
export function createAccountDeletionObjectStore(config: R2ClientConfig): AccountDeletionObjectStore {
  const endpoint = config.endpoint ?? (config.accountId ? `https://${config.accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new Error('Storage cleanup configuration unavailable');
  const s3 = new S3Client({ region: 'auto', endpoint, forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  return {
    async listObjects(prefix, cursor) {
      const result = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix,
        MaxKeys: 1000, ContinuationToken: cursor }), { abortSignal: AbortSignal.timeout(10_000) });
      const keys = (result.Contents ?? []).map((entry) => entry.Key);
      if (keys.some((key) => !key) || (result.IsTruncated && !result.NextContinuationToken)) throw new Error('Storage inventory incomplete');
      return { keys: keys as string[], nextCursor: result.IsTruncated ? result.NextContinuationToken! : null };
    },
    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
    },
    async abortOwnerMultipartUploads(prefix) {
      for (let page = 0; page < 100; page++) {
        const result = await s3.send(new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix: prefix, MaxUploads: 1000 }),
          { abortSignal: AbortSignal.timeout(10_000) });
        const uploads = result.Uploads ?? [];
        if (!uploads.length) {
          if (result.IsTruncated) throw new Error('Storage multipart inventory incomplete');
          return;
        }
        for (const upload of uploads) {
          if (!upload.Key?.startsWith(prefix) || !upload.UploadId) throw new Error('Storage ownership mismatch');
          try {
            await s3.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: upload.Key, UploadId: upload.UploadId }),
              { abortSignal: AbortSignal.timeout(30_000) });
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'NoSuchUpload') throw error;
          }
        }
      }
      throw new Error('Storage multipart cleanup pending');
    },
    async getPresignedGetUrl(key, expiresIn = 900) {
      return getSignedUrl(s3 as never, new GetObjectCommand({ Bucket: config.bucket, Key: key }) as never, { expiresIn });
    },
    destroy() { s3.destroy(); },
  };
}
