import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileBlobRoutes } from "../../packages/gateway/src/file-blob-routes";

describe("streamed attachment downloads", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "matrix-stream-download-")); });
  afterEach(async () => { await rm(home, { force: true, recursive: true }); });
  it("streams above 10 MiB and emits a safe Unicode attachment filename", async () => {
    const name = "报告 & archive.bin";
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 7, 193);
    await writeFile(join(home, name), bytes);
    const app = createFileBlobRoutes({ homePath: home });
    const response = await app.request(`/media?path=${encodeURIComponent(name)}&download=true`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const reader = response.body!.getReader();
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(Buffer.from(value).equals(bytes.subarray(offset, offset + value.length))).toBe(true);
      offset += value.length;
    }
    expect(offset).toBe(bytes.length);
  });
  it.each([0, 8 * 1024 ** 3])("preflights a %i-byte sparse file without a response body", async (size) => {
    await writeFile(join(home, "archive.bin"), "");
    await truncate(join(home, "archive.bin"), size);
    const app = createFileBlobRoutes({ homePath: home });
    const response = await app.request("/media?path=archive.bin&download=true", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(await response.text()).toBe("");
    if (size === 0) {
      const empty = await app.request("/media?path=archive.bin&download=true");
      expect(empty.status).toBe(200);
      expect(await empty.text()).toBe("");
    }
  });
  it("supports HEAD and safe resume, falling back to the full file on stale If-Range", async () => {
    await writeFile(join(home, "archive.bin"), "abcdef");
    const app = createFileBlobRoutes({ homePath: home });
    const url = "/media?path=archive.bin&download=true";
    const head = await app.request(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect(head.headers.get("etag")).toBeTruthy();
    expect(await head.text()).toBe("");
    const part = await app.request(url, { headers: { Range: "bytes=3-", "If-Range": head.headers.get("etag")! } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("def");
    const stale = await app.request(url, { headers: { Range: "bytes=3-", "If-Range": '"old"' } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("abcdef");
  });
  it("caps open streams, releases capacity on cancellation, and closes idle streams", async () => {
    await writeFile(join(home, "archive.bin"), "a");
    await truncate(join(home, "archive.bin"), 20 * 1024 * 1024);
    const app = createFileBlobRoutes({ homePath: home, downloadOptions: { maxConcurrent: 1, idleTimeoutMs: 100 } });
    const url = "/media?path=archive.bin&download=true";
    const first = await app.request(url);
    expect((await app.request(url)).status).toBe(429);
    await first.body!.cancel();
    const second = await app.request(url);
    expect(second.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(second.arrayBuffer()).rejects.toThrow();
    const third = await app.request(url);
    expect(third.status).toBe(200);
    await third.body!.cancel();
  });
  it("aborts on client disconnect and releases its file descriptor", async () => {
    await writeFile(join(home, "archive.bin"), Buffer.alloc(128 * 1024));
    const app = createFileBlobRoutes({ homePath: home, downloadOptions: { maxConcurrent: 1 } });
    const controller = new AbortController();
    const url = "/media?path=archive.bin&download=true";
    const response = await app.request(url, { signal: controller.signal });
    controller.abort();
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(async () => expect((await app.request(url, { method: "HEAD" })).status).toBe(200));
  });
  it("fails an interrupted source instead of closing a truncated body as success", async () => {
    const path = join(home, "archive.bin");
    await writeFile(path, Buffer.alloc(128 * 1024));
    const app = createFileBlobRoutes({ homePath: home });
    const response = await app.request("/media?path=archive.bin&download=true");
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBe(64 * 1024);
    await truncate(path, 0);
    await expect(reader.read()).rejects.toThrow();
  });
  it("rejects same-size source changes before sending the final chunk", async () => {
    const path = join(home, "archive.bin");
    await writeFile(path, Buffer.alloc(128 * 1024, 1));
    const app = createFileBlobRoutes({ homePath: home });
    const response = await app.request("/media?path=archive.bin&download=true");
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBe(64 * 1024);
    await writeFile(path, Buffer.alloc(128 * 1024, 2));
    await expect(reader.read()).rejects.toThrow();
  });
  it("keeps denied paths and symlink escapes out of download and HEAD responses", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-download-outside-"));
    try {
      await writeFile(join(outside, "secret.bin"), "outside-secret");
      await mkdir(join(home, "folder"));
      await mkdir(join(home, "data/browser-profiles"), { recursive: true });
      await writeFile(join(home, "data/browser-profiles/secret.bin"), "profile-secret");
      await symlink(outside, join(home, "escape"));
      await symlink(join(home, "data/browser-profiles"), join(home, "alias"));
      const app = createFileBlobRoutes({ homePath: home });
      for (const path of ["../outside", "escape/secret.bin", "folder", "data/browser-profiles/secret.bin", "alias/secret.bin"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await app.request(`/media?download=true&path=${encodeURIComponent(path)}`, { method });
          expect([400,404]).toContain(response.status);
          expect(response.headers.get("content-disposition")).toBeNull();
          expect(await response.text()).not.toContain("secret");
        }
      }
    } finally { await rm(outside, { force: true, recursive: true }); }
  });
});
