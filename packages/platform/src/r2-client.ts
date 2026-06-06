import { buildFileKey, buildManifestKey } from "./r2-keys.js";

async function loadS3() {
  const [s3, presigner] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner"),
  ]);
  return { ...s3, getSignedUrl: presigner.getSignedUrl };
}

const DEFAULT_PRESIGN_EXPIRY = 900;
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
  getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<{ etag?: string }>;
  deleteObject(key: string): Promise<void>;
  destroy(): void;
}

function normalizeConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function createR2Client(config: R2ClientConfig): Promise<R2Client> {
  const accountId = normalizeConfigValue(config.accountId);
  const accessKeyId = normalizeConfigValue(config.accessKeyId);
  const secretAccessKey = normalizeConfigValue(config.secretAccessKey);
  const bucket = normalizeConfigValue(config.bucket);
  const endpoint =
    normalizeConfigValue(config.endpoint) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  const publicEndpoint = normalizeConfigValue(config.publicEndpoint);
  if (!endpoint) {
    throw new Error("R2 client requires either accountId or endpoint");
  }
  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2 client requires access key, secret key, and bucket");
  }

  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    getSignedUrl,
  } = await loadS3();
  const s3 = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: { accessKeyId, secretAccessKey },
  });

  function rewritePublicEndpoint(url: string): string {
    if (!publicEndpoint) return url;
    const signed = new URL(url);
    const publicUrl = new URL(publicEndpoint);
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
      // Runtime behavior is correct; the cast only avoids cross-package type skew.
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
      // AWS SDK version mismatch: S3Client and getSignedUrl have divergent
      // generics across @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
      // Runtime behavior is correct; the cast only avoids cross-package type skew.
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
      // AWS SDK version mismatch: S3Client and getSignedUrl have divergent
      // generics across @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
      // Runtime behavior is correct; the cast only avoids cross-package type skew.
      return rewritePublicEndpoint(await getSignedUrl(s3 as any, command as any, {
        expiresIn,
        signingDate: new Date(),
      }));
    },

    async getObject(
      key: string,
      options?: { signal?: AbortSignal },
    ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }> {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3.send(command, {
        abortSignal: options?.signal ?? AbortSignal.timeout(R2_READ_TIMEOUT_MS),
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
      options?: { signal?: AbortSignal },
    ): Promise<{ etag?: string }> {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
      });
      const response = await s3.send(command, {
        abortSignal: options?.signal ?? AbortSignal.timeout(R2_WRITE_TIMEOUT_MS),
      });
      return { etag: response.ETag ?? undefined };
    },

    async deleteObject(key: string): Promise<void> {
      const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
      await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_WRITE_TIMEOUT_MS),
      });
    },

    destroy(): void {
      s3.destroy();
    },
  };
}

export { buildFileKey, buildManifestKey } from "./r2-keys.js";
