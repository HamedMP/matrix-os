import { buildFileKey, buildManifestKey } from "./r2-keys.js";
import { Readable } from "node:stream";

type S3ClientType = import("@aws-sdk/client-s3").S3Client;

export interface MultipartUploadedPart {
  partNumber: number;
  etag: string;
}

async function loadS3() {
  const [s3, presigner] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner"),
  ]);
  return { ...s3, getSignedUrl: presigner.getSignedUrl };
}

const DEFAULT_PRESIGN_EXPIRY = 900; // 15 minutes
export const R2_READ_TIMEOUT_MS = 10_000;
export const R2_WRITE_TIMEOUT_MS = 30_000;
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
  listMultipartUploads(key: string): Promise<{ key: string; uploadId: string }[]>;
  createMultipartUpload(key: string): Promise<string>;
  getPresignedPartUrl(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartUploadedPart[],
  ): Promise<{ etag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array> | Readable,
    options?: { signal?: AbortSignal; contentLength?: number },
  ): Promise<{ etag?: string }>;
  headObject(key: string): Promise<{ exists: boolean; etag?: string }>;
  deleteObject(key: string): Promise<void>;
  destroy(): void;
}

export async function createR2Client(config: R2ClientConfig): Promise<R2Client> {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config;
  const endpoint = config.endpoint ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  if (!endpoint) {
    throw new Error("R2 client requires either accountId or endpoint");
  }

  const {
    S3Client,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    CreateMultipartUploadCommand,
    ListMultipartUploadsCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    getSignedUrl,
  } = await loadS3();
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

    async listMultipartUploads(key: string): Promise<{ key: string; uploadId: string }[]> {
      const response = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key, MaxUploads: 11 }), {
        abortSignal: AbortSignal.timeout(R2_READ_TIMEOUT_MS),
      });
      if (response.IsTruncated) throw new Error("Storage recovery capacity exceeded");
      const matches = (response.Uploads ?? []).filter(upload => upload.Key === key);
      if (matches.length > 10 || matches.some(upload => !upload.UploadId)) throw new Error("Storage recovery capacity exceeded");
      return matches.map(upload => ({ key, uploadId: upload.UploadId! }));
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

    async completeMultipartUpload(
      key: string,
      uploadId: string,
      parts: MultipartUploadedPart[],
    ): Promise<{ etag?: string }> {
      const orderedParts = [...parts]
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
        }));
      const command = new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: orderedParts },
      });
      const response = await s3.send(command, {
        abortSignal: AbortSignal.timeout(R2_WRITE_TIMEOUT_MS),
      });
      return { etag: response.ETag ?? undefined };
    },

    async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
      const command = new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      });
      try {
        await s3.send(command, { abortSignal: AbortSignal.timeout(R2_WRITE_TIMEOUT_MS) });
      } catch (error: unknown) {
        if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
      }
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
      body: string | Uint8Array | ReadableStream<Uint8Array> | Readable,
      options?: { signal?: AbortSignal; contentLength?: number },
    ): Promise<{ etag?: string }> {
      const streaming = typeof body !== "string" && !(body instanceof Uint8Array);
      // The SDK's checksum middleware cannot hash a web stream or a stream of unknown length.
      if (streaming && options?.contentLength === undefined) {
        throw new Error("Streaming uploads require a content length");
      }
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body instanceof ReadableStream ? Readable.fromWeb(body as import("node:stream/web").ReadableStream) : body,
        ...(options?.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      });
      const response = await s3.send(command, {
        abortSignal: options?.signal ?? AbortSignal.timeout(R2_WRITE_TIMEOUT_MS),
      });
      return { etag: response.ETag ?? undefined };
    },

    async headObject(key: string): Promise<{ exists: boolean; etag?: string }> {
      try {
        const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: AbortSignal.timeout(R2_READ_TIMEOUT_MS),
        });
        return { exists: true, etag: response.ETag ?? undefined };
      } catch (error: unknown) {
        if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) return { exists: false };
        throw error;
      }
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

export {
  buildFileKey,
  buildBlobKey,
  buildManifestGenerationKey,
  buildManifestKey,
  buildStagingKey,
} from "./r2-keys.js";
