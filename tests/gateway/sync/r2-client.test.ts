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
  buildManifestKey,
  type R2Client,
} from "../../../packages/gateway/src/sync/r2-client.js";

describe("R2 client", () => {
  let client: R2Client;

  beforeEach(() => {
    vi.clearAllMocks();
    createdClientConfigs.length = 0;
    client = createR2Client({
      accountId: "test-account",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      bucket: "matrixos-sync",
    });
  });

  it("uses an explicit endpoint override when provided", () => {
    createR2Client({
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

  it("throws when neither endpoint nor accountId is configured", () => {
    expect(() =>
      createR2Client({
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret",
        bucket: "matrixos-sync",
      }),
    ).toThrow(/accountId|endpoint/i);
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
      const publicClient = createR2Client({
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
      mockSend.mockResolvedValue({
        Body: null,
        ETag: '"abc123"',
      });

      const result = await client.getObject("matrixos-sync/user1/manifest.json");

      expect(mockSend).toHaveBeenCalledOnce();
      const [, options] = mockSend.mock.calls[0]!;
      expect(options.abortSignal).toBeDefined();
      expect(result.etag).toBe('"abc123"');
      expect(result.body).toBeNull();
    });
  });

  describe("putObject", () => {
    it("sends PutObjectCommand with AbortSignal timeout", async () => {
      mockSend.mockResolvedValue({ ETag: '"def456"' });

      const result = await client.putObject("key", "content");

      expect(mockSend).toHaveBeenCalledOnce();
      const [command, options] = mockSend.mock.calls[0]!;
      expect(command.Body).toBe("content");
      expect(options.abortSignal).toBeDefined();
      expect(result.etag).toBe('"def456"');
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

  it("rejects unsafe user ids", () => {
    expect(() => buildFileKey("../hamed", "apps/calculator/index.html")).toThrow(
      /Invalid sync user id/,
    );
    expect(() => buildManifestKey("bad/user")).toThrow(/Invalid sync user id/);
  });
});
