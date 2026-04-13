import { describe, it, expect, vi, beforeEach } from "vitest";

const HASH_A = "sha256:" + "a".repeat(64);

const mockR2 = {
  getPresignedGetUrl: vi.fn(),
  getPresignedPutUrl: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  destroy: vi.fn(),
};

import {
  generatePresignedUrls,
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
    ).rejects.toThrow(/path/i);
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

  it("rejects files exceeding 100MB for PUT", async () => {
    await expect(
      generatePresignedUrls(deps, "user1", [
        {
          path: "big-file.bin",
          action: "put" as const,
          hash: HASH_A,
          size: 101 * 1024 * 1024,
        },
      ]),
    ).rejects.toThrow(/100.*MB|size/i);
  });

  it("accepts files at exactly 100MB for PUT", async () => {
    const result = await generatePresignedUrls(deps, "user1", [
      {
        path: "exact.bin",
        action: "put" as const,
        hash: HASH_A,
        size: 100 * 1024 * 1024,
      },
    ]);

    expect(result).toHaveLength(1);
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
});
