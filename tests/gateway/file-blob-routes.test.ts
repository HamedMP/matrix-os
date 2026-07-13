import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileBlobRoutes } from "../../packages/gateway/src/file-blob-routes.js";

describe("file blob routes", () => {
  let homePath: string;
  let app: ReturnType<typeof createFileBlobRoutes>;

  beforeEach(async () => {
    homePath = resolve(await mkdtemp(join(tmpdir(), "matrix-file-blob-")));
    app = createFileBlobRoutes({ homePath });
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  it("uploads and downloads a single file through the Matrix home", async () => {
    const put = await app.request("/blob?path=projects/demo/readme.md", {
      method: "PUT",
      body: "hello matrix",
    });

    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      ok: true,
      path: "projects/demo/readme.md",
      size: 12,
    });
    expect(await readFile(join(homePath, "projects/demo/readme.md"), "utf8")).toBe("hello matrix");

    const get = await app.request("/blob?path=projects/demo/readme.md");

    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello matrix");
    expect(get.headers.get("content-type")).toContain("text/markdown");
  });

  it("keeps the local filename when the Matrix destination is a directory", async () => {
    await mkdir(join(homePath, "dev/matrix-os"), { recursive: true });

    const put = await app.request(
      "/blob?path=dev%2Fmatrix-os&filename=codex-security-findings.csv",
      { method: "PUT", body: "finding\n" },
    );

    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      ok: true,
      path: "dev/matrix-os/codex-security-findings.csv",
      size: 8,
    });
    expect(await readFile(join(homePath, "dev/matrix-os/codex-security-findings.csv"), "utf8"))
      .toBe("finding\n");
  });

  it("writes secret uploads with owner-only file permissions", async () => {
    const res = await app.request("/blob?path=.codex/auth.json&secret=true", {
      method: "PUT",
      body: JSON.stringify({ token: "secret" }),
    });

    expect(res.status).toBe(200);
    const mode = (await stat(join(homePath, ".codex/auth.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects overwrites unless force is set", async () => {
    await mkdir(join(homePath, "notes"), { recursive: true });
    await writeFile(join(homePath, "notes/today.md"), "old");

    const blocked = await app.request("/blob?path=notes/today.md", {
      method: "PUT",
      body: "new",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "file_exists" });
    expect(await readFile(join(homePath, "notes/today.md"), "utf8")).toBe("old");

    const replaced = await app.request("/blob?path=notes/today.md&force=true", {
      method: "PUT",
      body: "new",
    });
    expect(replaced.status).toBe(200);
    expect(await readFile(join(homePath, "notes/today.md"), "utf8")).toBe("new");
  });

  it("rejects traversal, directories, oversized bodies, and symlink parents without leaking paths", async () => {
    await mkdir(join(homePath, "safe"), { recursive: true });
    await symlink("/tmp", join(homePath, "safe/link"));

    const traversal = await app.request("/blob?path=../outside.txt", {
      method: "PUT",
      body: "x",
    });
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({ error: "invalid_path" });

    const filenameTraversal = await app.request(
      "/blob?path=safe&filename=..%2Foutside.txt",
      { method: "PUT", body: "x" },
    );
    expect(filenameTraversal.status).toBe(400);
    expect(await filenameTraversal.json()).toEqual({ error: "invalid_path" });
    await expect(readFile(join(homePath, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const symlinkParent = await app.request("/blob?path=safe/link/secret.txt", {
      method: "PUT",
      body: "x",
    });
    expect(symlinkParent.status).toBe(400);
    expect(await symlinkParent.text()).not.toContain(homePath);

    const directory = await app.request("/blob?path=safe");
    expect(directory.status).toBe(400);
    expect(await directory.json()).toEqual({ error: "not_file" });

    const tooLarge = await app.request("/blob?path=huge.bin", {
      method: "PUT",
      body: "x".repeat(10 * 1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: "payload_too_large" });
  });
});
