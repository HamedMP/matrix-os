import { describe, it, expect, vi, beforeEach } from "vitest";

const HASH_A = "sha256:" + "a".repeat(64);

const mockR2 = {
  getPresignedGetUrl: vi.fn(),
  getPresignedPutUrl: vi.fn(),
  createMultipartUpload: vi.fn(),
  getPresignedPartUrl: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  destroy: vi.fn(),
};

import {
  generatePresignedUrls,
  PresignValidationError,
  type PresignDeps,
} from "../../../packages/gateway/src/sync/presign.js";

describe("generatePresignedUrls", () => {
  let deps: PresignDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    mockR2.getPresignedGetUrl.mockResolvedValue("https://r2.example.com/get");
    mockR2.getPresignedPutUrl.mockResolvedValue("https://r2.example.com/put");
    deps = { r2: mockR2 };
  });

  it("generates GET presigned URLs for download actions", async () => {
    const result = await generatePresignedUrls(deps, "user1", [
      { path: "docs/readme.md", action: "get" as const },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("docs/readme.md");
    expect(result[0]!.url).toBe("https://r2.example.com/get");
    expect(result[0]!.expiresIn).toBe(900);
  });

  it("generates PUT presigned URLs for upload actions", async () => {
    const result = await generatePresignedUrls(deps, "user1", [
      { path: "apps/test.ts", action: "put" as const, hash: HASH_A, size: 500 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe("https://r2.example.com/put");
    expect(result[0]!.expiresIn).toBe(900);
  });

  it("validates all paths and rejects traversal attempts", async () => {
    await expect(
      generatePresignedUrls(deps, "user1", [
        { path: "../etc/passwd", action: "get" as const },
      ]),
    ).rejects.toBeInstanceOf(PresignValidationError);
  });

  it("handles batch of up to 100 files", async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      path: `file-${i}.txt`,
      action: "get" as const,
    }));

    const result = await generatePresignedUrls(deps, "user1", files);

    expect(result).toHaveLength(100);
    expect(mockR2.getPresignedGetUrl).toHaveBeenCalledTimes(100);
  });

  it("passes correct R2 keys scoped to user prefix", async () => {
    await generatePresignedUrls(deps, "user1", [
      { path: "apps/my-app/index.html", action: "get" as const },
    ]);

    expect(mockR2.getPresignedGetUrl).toHaveBeenCalledWith(
      "matrixos-sync/user1/files/apps/my-app/index.html",
      900,
    );
  });

  it("rejects files exceeding 1GB for PUT", async () => {
    await expect(
      generatePresignedUrls(deps, "user1", [
        {
          path: "huge-file.bin",
          action: "put" as const,
          hash: HASH_A,
          size: 1025 * 1024 * 1024,
        },
      ]),
    ).rejects.toBeInstanceOf(PresignValidationError);
  });

  it("accepts files at exactly 100MB for PUT (single presign)", async () => {
    const result = await generatePresignedUrls(deps, "user1", [
      {
        path: "exact.bin",
        action: "put" as const,
        hash: HASH_A,
        size: 100 * 1024 * 1024,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe("https://r2.example.com/put");
    expect(result[0]!.multipart).toBeUndefined();
  });

  it("generates mixed GET and PUT in one batch", async () => {
    const result = await generatePresignedUrls(deps, "user1", [
      { path: "download.txt", action: "get" as const },
      { path: "upload.txt", action: "put" as const, hash: HASH_A, size: 100 },
    ]);

    expect(result).toHaveLength(2);
    expect(mockR2.getPresignedGetUrl).toHaveBeenCalledOnce();
    expect(mockR2.getPresignedPutUrl).toHaveBeenCalledOnce();
  });

  it("returns multipart URLs for files >100MB", async () => {
    mockR2.createMultipartUpload.mockResolvedValue("upload-id-123");
    mockR2.getPresignedPartUrl.mockImplementation(
      async (_key: string, _uploadId: string, partNum: number) =>
        `https://r2.example.com/part-${partNum}`,
    );

    const size = 200 * 1024 * 1024; // 200MB
    const result = await generatePresignedUrls(deps, "user1", [
      { path: "large.bin", action: "put" as const, hash: HASH_A, size },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.multipart).toBeDefined();
    expect(result[0]!.multipart!.uploadId).toBe("upload-id-123");
    // 200MB / 64MB part size = 4 parts (ceil)
    expect(result[0]!.multipart!.partUrls.length).toBeGreaterThanOrEqual(2);
    expect(result[0]!.multipart!.partSize).toBeGreaterThan(0);
  });

  it("returns single PUT URL for files at exactly 100MB", async () => {
    const result = await generatePresignedUrls(deps, "user1", [
      {
        path: "boundary.bin",
        action: "put" as const,
        hash: HASH_A,
        size: 100 * 1024 * 1024,
      },
    ]);

    expect(result[0]!.multipart).toBeUndefined();
    expect(mockR2.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("accepts files up to 1GB for multipart PUT", async () => {
    mockR2.createMultipartUpload.mockResolvedValue("upload-id-1gb");
    mockR2.getPresignedPartUrl.mockResolvedValue("https://r2.example.com/part");

    const size = 1024 * 1024 * 1024; // exactly 1GB
    const result = await generatePresignedUrls(deps, "user1", [
      { path: "one-gb.bin", action: "put" as const, hash: HASH_A, size },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.multipart).toBeDefined();
  });
});
