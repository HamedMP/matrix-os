import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn();
const createdClientConfigs: unknown[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    constructor(config: unknown) {
      createdClientConfigs.push(config);
    }
    send = mockSend;
    destroy = vi.fn();
  }
  return {
    S3Client: MockS3Client,
    GetObjectCommand: class {
      Bucket: string;
      Key: string;
      constructor(params: { Bucket: string; Key: string }) {
        this.Bucket = params.Bucket;
        this.Key = params.Key;
      }
    },
    PutObjectCommand: class {
      Bucket: string;
      Key: string;
      Body?: unknown;
      ContentLength?: number;
      constructor(params: { Bucket: string; Key: string; Body?: unknown; ContentLength?: number }) {
        this.Bucket = params.Bucket;
        this.Key = params.Key;
        this.Body = params.Body;
        this.ContentLength = params.ContentLength;
      }
    },
      DeleteObjectCommand: class {
        Bucket: string;
        Key: string;
        constructor(params: { Bucket: string; Key: string }) {
          this.Bucket = params.Bucket;
          this.Key = params.Key;
        }
      },
      CreateMultipartUploadCommand: class {
        Bucket: string;
        Key: string;
        constructor(params: { Bucket: string; Key: string }) {
          this.Bucket = params.Bucket;
          this.Key = params.Key;
        }
      },
      UploadPartCommand: class {
        Bucket: string;
        Key: string;
        UploadId: string;
        PartNumber: number;
        constructor(params: { Bucket: string; Key: string; UploadId: string; PartNumber: number }) {
          this.Bucket = params.Bucket;
          this.Key = params.Key;
          this.UploadId = params.UploadId;
          this.PartNumber = params.PartNumber;
        }
      },
      CompleteMultipartUploadCommand: class {
        Bucket: string;
        Key: string;
        UploadId: string;
        MultipartUpload?: { Parts?: Array<{ PartNumber: number; ETag: string }> };
        constructor(params: {
          Bucket: string;
          Key: string;
          UploadId: string;
          MultipartUpload?: { Parts?: Array<{ PartNumber: number; ETag: string }> };
        }) {
          this.Bucket = params.Bucket;
          this.Key = params.Key;
          this.UploadId = params.UploadId;
          this.MultipartUpload = params.MultipartUpload;
        }
      },
      AbortMultipartUploadCommand: class {
        Bucket: string;
        Key: string;
        UploadId: string;
        constructor(params: { Bucket: string; Key: string; UploadId: string }) {
          this.Bucket = params.Bucket;
          this.Key = params.Key;
          this.UploadId = params.UploadId;
        }
      },
    };
  });

vi.mock("@aws-sdk/s3-request-presigner", () => {
  return {
    getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
  };
});

import {
  createR2Client,
  buildFileKey,
  buildBlobKey,
  buildManifestGenerationKey,
  buildManifestKey,
  buildStagingKey,
  type R2Client,
} from "../../../packages/gateway/src/sync/r2-client.js";

describe("R2 client", () => {
  let client: R2Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    createdClientConfigs.length = 0;
    client = await createR2Client({
      accountId: "test-account",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      bucket: "matrixos-sync",
    });
  });

  it("uses an explicit endpoint override when provided", async () => {
    await createR2Client({
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      bucket: "matrixos-sync",
      endpoint: "https://s3.example.internal",
      forcePathStyle: true,
    });

    expect(createdClientConfigs.at(-1)).toMatchObject({
      endpoint: "https://s3.example.internal",
      forcePathStyle: true,
    });
  });

  it("throws when neither endpoint nor accountId is configured", async () => {
    await expect(
      createR2Client({
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret",
        bucket: "matrixos-sync",
      }),
    ).rejects.toThrow(/accountId|endpoint/i);
  });

  describe("getPresignedGetUrl", () => {
    it("calls getSignedUrl with a GetObjectCommand", async () => {
      mockGetSignedUrl.mockResolvedValue("https://r2.example.com/presigned-get");

      const url = await client.getPresignedGetUrl("matrixos-sync/user1/files/test.txt");

      expect(mockGetSignedUrl).toHaveBeenCalledOnce();
      const [, command, options] = mockGetSignedUrl.mock.calls[0]!;
      expect(command.Bucket).toBe("matrixos-sync");
      expect(command.Key).toBe("matrixos-sync/user1/files/test.txt");
      expect(options.expiresIn).toBe(900);
      expect(url).toBe("https://r2.example.com/presigned-get");
    });

    it("uses custom expiry when provided", async () => {
      mockGetSignedUrl.mockResolvedValue("https://r2.example.com/custom");

      await client.getPresignedGetUrl("key", 3600);

      const [, , options] = mockGetSignedUrl.mock.calls[0]!;
      expect(options.expiresIn).toBe(3600);
    });
  });

  describe("getPresignedPutUrl", () => {
    it("calls getSignedUrl with a PutObjectCommand and signed content-length", async () => {
      mockGetSignedUrl.mockResolvedValue("https://r2.example.com/presigned-put");

      const url = await client.getPresignedPutUrl("matrixos-sync/user1/files/upload.txt", 123);

      expect(mockGetSignedUrl).toHaveBeenCalledOnce();
      const [, command, options] = mockGetSignedUrl.mock.calls[0]!;
      expect(command.Bucket).toBe("matrixos-sync");
      expect(command.Key).toBe("matrixos-sync/user1/files/upload.txt");
      expect(command.ContentLength).toBe(123);
      expect(options.expiresIn).toBe(900);
      expect(options.unhoistableHeaders).toEqual(new Set(["content-length"]));
      expect(url).toBe("https://r2.example.com/presigned-put");
    });

    it("rewrites presigned URLs to the configured public endpoint", async () => {
      const publicClient = await createR2Client({
        endpoint: "http://minio:9000",
        publicEndpoint: "http://localhost:9100",
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret",
        bucket: "matrixos-sync",
      });
      mockGetSignedUrl.mockResolvedValue(
        "http://minio:9000/matrixos-sync/user1/files/upload.txt?X-Amz-SignedHeaders=content-length%3Bhost",
      );

      const url = await publicClient.getPresignedPutUrl(
        "matrixos-sync/user1/files/upload.txt",
        123,
      );

      expect(url).toContain("http://localhost:9100/matrixos-sync/user1/files/upload.txt");
      expect(url).toContain("X-Amz-SignedHeaders=content-length%3Bhost");
    });
  });

  describe("getObject", () => {
    it("sends GetObjectCommand with AbortSignal timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      mockSend.mockResolvedValue({
        Body: null,
        ETag: '"abc123"',
      });

      const result = await client.getObject("matrixos-sync/user1/manifest.json");

      expect(mockSend).toHaveBeenCalledOnce();
      const [, options] = mockSend.mock.calls[0]!;
      expect(options.abortSignal).toBeDefined();
      expect(timeoutSpy).toHaveBeenLastCalledWith(10_000);
      expect(result.etag).toBe('"abc123"');
      expect(result.body).toBeNull();
    });
  });

  describe("putObject", () => {
    it("sends PutObjectCommand with AbortSignal timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      mockSend.mockResolvedValue({ ETag: '"def456"' });

      const result = await client.putObject("key", "content");

      expect(mockSend).toHaveBeenCalledOnce();
      const [command, options] = mockSend.mock.calls[0]!;
      expect(command.Body).toBe("content");
      expect(options.abortSignal).toBeDefined();
      expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
      expect(result.etag).toBe('"def456"');
    });

    it("sends streamed bodies as a Node stream with their declared length", async () => {
      mockSend.mockResolvedValue({ ETag: '"stream"' });
      const { Readable } = await import("node:stream");

      await client.putObject("key", new Response("hello").body!, { contentLength: 5 });

      const [command] = mockSend.mock.calls[0]!;
      expect(command.Body).toBeInstanceOf(Readable);
      expect(command.ContentLength).toBe(5);
    });

    it("rejects a streamed body without a length instead of letting the SDK fail", async () => {
      await expect(client.putObject("key", new Response("hello").body!))
        .rejects.toThrow("Streaming uploads require a content length");
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("deleteObject", () => {
    it("sends DeleteObjectCommand with AbortSignal timeout", async () => {
      mockSend.mockResolvedValue({});

      await client.deleteObject("matrixos-sync/user1/files/old.txt");

      expect(mockSend).toHaveBeenCalledOnce();
      const [command, options] = mockSend.mock.calls[0]!;
      expect(command.Key).toBe("matrixos-sync/user1/files/old.txt");
      expect(options.abortSignal).toBeDefined();
    });
  });

  describe("multipart completion", () => {
    it("sends CompleteMultipartUploadCommand with ordered parts and timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      mockSend.mockResolvedValue({ ETag: '"complete-etag"' });

      const result = await client.completeMultipartUpload(
        "matrixos-sync/user1/files/large.bin",
        "upload-123",
        [
          { partNumber: 2, etag: '"etag-2"' },
          { partNumber: 1, etag: '"etag-1"' },
        ],
      );

      expect(mockSend).toHaveBeenCalledOnce();
      const [command, options] = mockSend.mock.calls[0]!;
      expect(command.Key).toBe("matrixos-sync/user1/files/large.bin");
      expect(command.UploadId).toBe("upload-123");
      expect(command.MultipartUpload).toEqual({
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
      });
      expect(options.abortSignal).toBeDefined();
      expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
      expect(result.etag).toBe('"complete-etag"');
    });

    it("sends AbortMultipartUploadCommand with timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      mockSend.mockResolvedValue({});

      await client.abortMultipartUpload(
        "matrixos-sync/user1/files/large.bin",
        "upload-123",
      );

      expect(mockSend).toHaveBeenCalledOnce();
      const [command, options] = mockSend.mock.calls[0]!;
      expect(command.Key).toBe("matrixos-sync/user1/files/large.bin");
      expect(command.UploadId).toBe("upload-123");
      expect(options.abortSignal).toBeDefined();
      expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
    });
  });
});

describe("key builders", () => {
  it("buildFileKey constructs correct R2 key", () => {
    expect(buildFileKey("hamed", "apps/calculator/index.html")).toBe(
      "matrixos-sync/hamed/files/apps/calculator/index.html",
    );
  });

  it("buildManifestKey constructs correct manifest key", () => {
    expect(buildManifestKey("hamed")).toBe("matrixos-sync/hamed/manifest.json");
  });

  it("builds runtime-isolated keys for non-primary scopes", () => {
    const scope = { ownerId: "user_123", runtimeSlot: "studio" } as const;

    expect(buildFileKey(scope, "notes/today.md")).toBe(
      "matrixos-sync/v2/owners/user_123/runtimes/studio/files/notes/today.md",
    );
    expect(buildManifestKey(scope)).toBe(
      "matrixos-sync/v2/owners/user_123/runtimes/studio/manifest.json",
    );
  });

  it("builds content-addressed immutable manifest generation keys", () => {
    expect(buildManifestGenerationKey("hamed", 7, "a".repeat(64))).toBe(
      `matrixos-sync/hamed/manifests/7-${"a".repeat(64)}.json`,
    );
  });

  it("builds scoped staging and immutable blob keys", () => {
    const stagingId = "11111111-1111-4111-8111-111111111111";
    expect(buildStagingKey("hamed", stagingId)).toBe(
      `matrixos-sync/hamed/staging/${stagingId}`,
    );
    expect(buildBlobKey("hamed", `sha256:${"b".repeat(64)}`)).toBe(
      `matrixos-sync/hamed/objects/sha256/${"b".repeat(64)}`,
    );
  });

  it("rejects unsafe user ids", () => {
    expect(() => buildFileKey("../hamed", "apps/calculator/index.html")).toThrow(
      /Invalid sync user id/,
    );
    expect(() => buildManifestKey("bad/user")).toThrow(/Invalid sync user id/);
  });
});
