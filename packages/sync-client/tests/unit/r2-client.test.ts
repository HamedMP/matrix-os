import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
    AuthRejectedError,
    downloadFile,
    requestPresignedUrls,
    uploadFile,
  } from "../../src/daemon/r2-client.js";

describe("daemon/r2-client", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-r2-client-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("includes size in PUT presign requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          urls: [{ path: "notes/today.md", url: "https://example.test", expiresIn: 900 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await requestPresignedUrls(
      { gatewayUrl: "https://app.matrix-os.com", token: "token" },
      [{ path: "notes/today.md", action: "put", hash: `sha256:${"a".repeat(64)}`, size: 42 }],
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      files: [
        {
          path: "notes/today.md",
          action: "put",
          hash: `sha256:${"a".repeat(64)}`,
          size: 42,
        },
      ],
    });
  });

    it("throws AuthRejectedError for 401/403 presign responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );

    await expect(
      requestPresignedUrls(
        { gatewayUrl: "https://app.matrix-os.com", token: "token" },
        [{ path: "notes/today.md", action: "get" }],
      ),
    ).rejects.toBeInstanceOf(AuthRejectedError);
    });

    it("uploads multipart presigned files and completes them through the gateway", async () => {
      const localPath = join(tempDir, "large.bin");
      await writeFile(localPath, "hello world");
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (href === "https://r2.example.test/part-1") {
          expect(init?.method).toBe("PUT");
          expect((init?.headers as Record<string, string>)["Content-Length"]).toBe("5");
          return new Response(null, { status: 200, headers: { ETag: '"etag-1"' } });
        }
        if (href === "https://r2.example.test/part-2") {
          expect(init?.method).toBe("PUT");
          expect((init?.headers as Record<string, string>)["Content-Length"]).toBe("5");
          return new Response(null, { status: 200, headers: { ETag: '"etag-2"' } });
        }
        if (href === "https://r2.example.test/part-3") {
          expect(init?.method).toBe("PUT");
          expect((init?.headers as Record<string, string>)["Content-Length"]).toBe("1");
          return new Response(null, { status: 200, headers: { ETag: '"etag-3"' } });
        }
        if (href === "https://app.matrix-os.com/api/sync/multipart/complete") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            path: "large.bin",
            uploadId: "upload-123",
            parts: [
              { partNumber: 1, etag: '"etag-1"' },
              { partNumber: 2, etag: '"etag-2"' },
              { partNumber: 3, etag: '"etag-3"' },
            ],
          });
          return new Response(JSON.stringify({ etag: '"complete-etag"' }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch ${href}`);
      });

      await uploadFile(
        {
          path: "large.bin",
          url: "",
          expiresIn: 900,
          multipart: {
            uploadId: "upload-123",
            partSize: 5,
            partUrls: [
              "https://r2.example.test/part-1",
              "https://r2.example.test/part-2",
              "https://r2.example.test/part-3",
            ],
          },
        },
        localPath,
        { gatewayUrl: "https://app.matrix-os.com", token: "token" },
      );

      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("aborts multipart uploads when a part upload fails", async () => {
      const localPath = join(tempDir, "large.bin");
      await writeFile(localPath, "helloworld");
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const href = String(url);
        if (href === "https://r2.example.test/part-1") {
          return new Response(null, { status: 200, headers: { ETag: '"etag-1"' } });
        }
        if (href === "https://r2.example.test/part-2") {
          return new Response("failed", { status: 503 });
        }
        if (href === "https://app.matrix-os.com/api/sync/multipart/abort") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch ${href}`);
      });

      await expect(
        uploadFile(
          {
            path: "large.bin",
            url: "",
            expiresIn: 900,
            multipart: {
              uploadId: "upload-123",
              partSize: 5,
              partUrls: [
                "https://r2.example.test/part-1",
                "https://r2.example.test/part-2",
              ],
            },
          },
          localPath,
          { gatewayUrl: "https://app.matrix-os.com", token: "token" },
        ),
      ).rejects.toThrow(/upload failed/i);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/sync/multipart/abort",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ path: "large.bin", uploadId: "upload-123" }),
        }),
      );
    });

    it("verifies download hashes before replacing the destination file", async () => {
    const finalPath = join(tempDir, "notes", "today.md");
    const body = Buffer.from("tampered");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await expect(
      downloadFile(
        "https://example.test/get",
        finalPath,
        `sha256:${createHash("sha256").update("expected").digest("hex")}`,
      ),
    ).rejects.toThrow(/hash/i);

    await expect(stat(finalPath)).rejects.toThrow(/ENOENT/);
    expect(await readdir(join(tempDir, "notes")).catch(() => [])).toEqual([]);
  });

  it("writes downloads atomically through a temp file + rename", async () => {
    const finalPath = join(tempDir, "notes", "today.md");
    const body = Buffer.from("hello world");
    const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await downloadFile("https://example.test/get", finalPath, hash);

    expect(await readFile(finalPath, "utf8")).toBe("hello world");
    expect(
      (await readdir(join(tempDir, "notes"))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("does not clobber stale PID-based temp files from an earlier crash", async () => {
    const finalPath = join(tempDir, "notes", "today.md");
    const legacyTmpPath = `${finalPath}.${process.pid}.tmp`;
    const body = Buffer.from("hello world");
    const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    await (await import("node:fs/promises")).mkdir(join(tempDir, "notes"), { recursive: true });
    await writeFile(legacyTmpPath, "stale temp");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await downloadFile("https://example.test/get", finalPath, hash);

    expect(await readFile(finalPath, "utf8")).toBe("hello world");
    expect(await readFile(legacyTmpPath, "utf8")).toBe("stale temp");
  });

  it("refuses to overwrite an existing symlink target", async () => {
    const finalPath = join(tempDir, "notes", "today.md");
    const realTarget = join(tempDir, "outside.txt");
    const body = Buffer.from("hello world");
    const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;

    await writeFile(realTarget, "outside");
    await (await import("node:fs/promises")).mkdir(join(tempDir, "notes"), { recursive: true });
    await (await import("node:fs/promises")).symlink(realTarget, finalPath);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await expect(downloadFile("https://example.test/get", finalPath, hash)).rejects.toThrow(
      /symlink/i,
    );
    expect(await readFile(realTarget, "utf8")).toBe("outside");
    expect((await (await import("node:fs/promises")).lstat(finalPath)).isSymbolicLink()).toBe(true);
  });
});
