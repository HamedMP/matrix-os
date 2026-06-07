import { beforeEach, describe, expect, it, vi } from "vitest";

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
      constructor(public params: unknown) {}
    },
    PutObjectCommand: class {
      constructor(public params: unknown) {}
    },
    DeleteObjectCommand: class {
      constructor(public params: unknown) {}
    },
    CreateMultipartUploadCommand: class {
      constructor(public params: unknown) {}
    },
    UploadPartCommand: class {
      constructor(public params: unknown) {}
    },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import { createR2Client } from "../../packages/platform/src/r2-client.js";

describe("platform R2 client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdClientConfigs.length = 0;
  });

  it("trims object-store secrets and endpoints before creating the S3 client", async () => {
    mockGetSignedUrl.mockResolvedValue("https://internal.example.com/bundle.tar.gz?sig=1");
    const client = await createR2Client({
      accountId: " account-id\n",
      accessKeyId: "bundle-key\n",
      secretAccessKey: " bundle-secret ",
      bucket: " matrixos-bundles\n",
      publicEndpoint: " https://bundles.example.com\n",
    });

    expect(createdClientConfigs.at(-1)).toMatchObject({
      endpoint: "https://account-id.r2.cloudflarestorage.com",
      credentials: {
        accessKeyId: "bundle-key",
        secretAccessKey: "bundle-secret",
      },
    });

    await expect(client.getPresignedGetUrl("system-bundles/dev.tar.gz")).resolves.toBe(
      "https://bundles.example.com/bundle.tar.gz?sig=1",
    );
    client.destroy();
  });

  it("rejects blank credentials after trimming", async () => {
    await expect(
      createR2Client({
        endpoint: "https://r2.example.com",
        accessKeyId: "\n",
        secretAccessKey: "secret",
        bucket: "matrixos-bundles",
      }),
    ).rejects.toThrow(/access key, secret key, and bucket/i);
  });
});
