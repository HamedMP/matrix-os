import { afterEach, describe, expect, it, vi } from "vitest";

import { createR2Client } from "../../packages/platform/src/r2-client.js";

describe("platform R2 client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trims object-store secrets and endpoints before creating the S3 client", async () => {
    const client = await createR2Client({
      accountId: " account-id\n",
      accessKeyId: "bundle-key\n",
      secretAccessKey: " bundle-secret ",
      bucket: " matrixos-bundles\n",
    });

    const url = new URL(await client.getPresignedGetUrl("system-bundles/dev.tar.gz"));
    expect(url.hostname).toBe("matrixos-bundles.account-id.r2.cloudflarestorage.com");
    expect(url.pathname).toContain("system-bundles/dev.tar.gz");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("bundle-key");
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

  it("signs public URLs with a separate public-endpoint client", async () => {
    const client = await createR2Client({
      endpoint: "http://127.0.0.1:9121",
      publicEndpoint: " https://bundles.example.com\n",
      accessKeyId: "bundle-key",
      secretAccessKey: "bundle-secret",
      bucket: "matrixos-bundles",
      forcePathStyle: true,
    });

    const url = new URL(await client.getPresignedGetUrl("system-bundles/dev.tar.gz"));
    expect(url.origin).toBe("https://bundles.example.com");
    expect(url.port).toBe("");
    expect(url.pathname).toBe("/matrixos-bundles/system-bundles/dev.tar.gz");
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
    client.destroy();
  });

  it("completes and aborts multipart uploads through the production client", async () => {
    const { S3Client, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = await import(
      "@aws-sdk/client-s3"
    );
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof CompleteMultipartUploadCommand) return { ETag: '"complete"' } as any;
      if (command instanceof AbortMultipartUploadCommand) return {} as any;
      throw new Error("unexpected command");
    });
    const client = await createR2Client({
      endpoint: "https://r2.example.com",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucket: "matrixos-sync",
    });

    await expect(client.completeMultipartUpload("user/system/db/snapshot.dump", "upload-1", [
      { partNumber: 1, etag: '"part-1"' },
    ])).resolves.toEqual({ etag: '"complete"' });
    await expect(client.abortMultipartUpload("user/system/db/snapshot.dump", "upload-2")).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect((send.mock.calls[0]?.[0] as any).input).toEqual({
      Bucket: "matrixos-sync",
      Key: "user/system/db/snapshot.dump",
      UploadId: "upload-1",
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"part-1"' }] },
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
    expect((send.mock.calls[1]?.[0] as any).input).toEqual({
      Bucket: "matrixos-sync",
      Key: "user/system/db/snapshot.dump",
      UploadId: "upload-2",
    });
    client.destroy();
  });

  it("returns bounded object and multipart listings for maintenance", async () => {
    const {
      S3Client,
      ListObjectsV2Command,
      ListMultipartUploadsCommand,
    } = await import("@aws-sdk/client-s3");
    const modified = new Date("2026-09-01T00:00:00.000Z");
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: "matrixos-sync/user/staging/object", LastModified: modified, Size: 4 }],
          IsTruncated: true,
        } as any;
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return {
          Uploads: [{ Key: "matrixos-sync/user/staging/object", UploadId: "upload-1", Initiated: modified }],
          IsTruncated: false,
        } as any;
      }
      throw new Error("unexpected command");
    });
    const client = await createR2Client({
      endpoint: "https://r2.example.com",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucket: "matrixos-sync",
    });

    await expect(client.listObjects("matrixos-sync/user/staging/", { maxKeys: 20 })).resolves.toEqual({
      objects: [{
        key: "matrixos-sync/user/staging/object",
        lastModified: modified,
        size: 4,
      }],
      isTruncated: true,
    });
    await expect(client.listMultipartUploads("matrixos-sync/user/staging/", {
      maxUploads: 20,
    })).resolves.toEqual({
      uploads: [{
        key: "matrixos-sync/user/staging/object",
        uploadId: "upload-1",
        initiated: modified,
      }],
      isTruncated: false,
    });

    expect(send).toHaveBeenCalledTimes(2);
    client.destroy();
  });
});
