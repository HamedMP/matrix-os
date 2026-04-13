import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_PRESIGN_EXPIRY = 900; // 15 minutes
const R2_OPERATION_TIMEOUT_MS = 10_000;

export interface R2ClientConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface R2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, expiresIn?: number): Promise<string>;
  getObject(key: string): Promise<{ body: ReadableStream | null; etag?: string }>;
  putObject(key: string, body: string | Uint8Array): Promise<{ etag?: string }>;
  deleteObject(key: string): Promise<void>;
  destroy(): void;
}

export function createR2Client(config: R2ClientConfig): R2Client {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config;

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async getPresignedGetUrl(
      key: string,
      expiresIn = DEFAULT_PRESIGN_EXPIRY,
    ): Promise<string> {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      // AWS SDK version mismatch: S3Client and getSignedUrl have divergent
      // generics across @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
      // The runtime behavior is correct; the cast silences the type error.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK cross-package type mismatch
      return getSignedUrl(s3 as any, command as any, {
        expiresIn,
        signingDate: new Date(),
      });
    },

    async getPresignedPutUrl(
      key: string,
      expiresIn = DEFAULT_PRESIGN_EXPIRY,
    ): Promise<string> {
      const command = new PutObjectCommand({ Bucket: bucket, Key: key });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK cross-package type mismatch
      return getSignedUrl(s3 as any, command as any, {
        expiresIn,
        signingDate: new Date(),
      });
    },

    async getObject(
      key: string,
    ): Promise<{ body: ReadableStream | null; etag?: string }> {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_OPERATION_TIMEOUT_MS),
      });
      return {
        body: (response.Body as ReadableStream | undefined) ?? null,
        etag: response.ETag ?? undefined,
      };
    },

    async putObject(
      key: string,
      body: string | Uint8Array,
    ): Promise<{ etag?: string }> {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
      });
      const response = await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_OPERATION_TIMEOUT_MS),
      });
      return { etag: response.ETag ?? undefined };
    },

    async deleteObject(key: string): Promise<void> {
      const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
      await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_OPERATION_TIMEOUT_MS),
      });
    },

    destroy(): void {
      s3.destroy();
    },
  };
}

export function buildFileKey(userId: string, relativePath: string): string {
  return `matrixos-sync/${userId}/files/${relativePath}`;
}

export function buildManifestKey(userId: string): string {
  return `matrixos-sync/${userId}/manifest.json`;
}
