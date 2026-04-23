import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildFileKey, buildManifestKey } from "./r2-keys.js";

const DEFAULT_PRESIGN_EXPIRY = 900; // 15 minutes
const R2_READ_TIMEOUT_MS = 10_000;
const R2_WRITE_TIMEOUT_MS = 30_000;
export interface R2ClientConfig {
  accountId?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
  publicEndpoint?: string;
  forcePathStyle?: boolean;
}

export interface R2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  createMultipartUpload(key: string): Promise<string>;
  getPresignedPartUrl(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<string>;
  getObject(key: string): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<{ etag?: string }>;
  deleteObject(key: string): Promise<void>;
  destroy(): void;
}

export function createR2Client(config: R2ClientConfig): R2Client {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config;
  const endpoint = config.endpoint ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  if (!endpoint) {
    throw new Error("R2 client requires either accountId or endpoint");
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: { accessKeyId, secretAccessKey },
  });

  function rewritePublicEndpoint(url: string): string {
    if (!config.publicEndpoint) return url;
    const signed = new URL(url);
    const publicUrl = new URL(config.publicEndpoint);
    signed.protocol = publicUrl.protocol;
    signed.host = publicUrl.host;
    return signed.toString();
  }

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
      return rewritePublicEndpoint(await getSignedUrl(s3 as any, command as any, {
        expiresIn,
        signingDate: new Date(),
      }));
    },

    async getPresignedPutUrl(
      key: string,
      size: number,
      expiresIn = DEFAULT_PRESIGN_EXPIRY,
    ): Promise<string> {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentLength: size,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK cross-package type mismatch
      return rewritePublicEndpoint(await getSignedUrl(s3 as any, command as any, {
        expiresIn,
        signingDate: new Date(),
        unhoistableHeaders: new Set(["content-length"]),
      }));
    },

    async createMultipartUpload(key: string): Promise<string> {
      const command = new CreateMultipartUploadCommand({ Bucket: bucket, Key: key });
      const response = await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_WRITE_TIMEOUT_MS),
      });
      if (!response.UploadId) {
        throw new Error("Failed to create multipart upload: no UploadId returned");
      }
      return response.UploadId;
    },

    async getPresignedPartUrl(
      key: string,
      uploadId: string,
      partNumber: number,
      expiresIn = DEFAULT_PRESIGN_EXPIRY,
    ): Promise<string> {
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK cross-package type mismatch
      return rewritePublicEndpoint(await getSignedUrl(s3 as any, command as any, {
        expiresIn,
        signingDate: new Date(),
      }));
    },

    async getObject(
      key: string,
    ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }> {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_READ_TIMEOUT_MS),
      });
      return {
        body: (response.Body as ReadableStream | undefined) ?? null,
        etag: response.ETag ?? undefined,
        contentLength: response.ContentLength ?? undefined,
      };
    },

    async putObject(
      key: string,
      body: string | Uint8Array | ReadableStream<Uint8Array>,
    ): Promise<{ etag?: string }> {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
      });
      const response = await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_WRITE_TIMEOUT_MS),
      });
      return { etag: response.ETag ?? undefined };
    },

    async deleteObject(key: string): Promise<void> {
      const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
      await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_READ_TIMEOUT_MS),
      });
    },

    destroy(): void {
      s3.destroy();
    },
  };
}

export { buildFileKey, buildManifestKey } from "./r2-keys.js";
