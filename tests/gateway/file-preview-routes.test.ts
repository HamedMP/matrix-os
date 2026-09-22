import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createFilePreviewRoutes } from "../../packages/gateway/src/file-preview-routes.js";
import { createFilePreviewService, openedPathIsAuthorized } from "../../packages/gateway/src/file-preview-service.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

describe("file preview routes", () => {
  let root: string;
  let homePath: string;
  let projectPath: string;
  let worktreeA: string;
  let worktreeB: string;
  let app: Hono;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

  beforeEach(async () => {
    root = resolve(await mkdtemp(join(tmpdir(), "matrix-file-preview-")));
    homePath = join(root, "home");
    projectPath = join(root, "project");
    worktreeA = join(root, "worktree-a");
    worktreeB = join(root, "worktree-b");
    await Promise.all([homePath, projectPath, worktreeA, worktreeB].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(projectPath, "output.png"), png);
    await writeFile(join(projectPath, "report.pdf"), Buffer.from("%PDF-1.7\nfixture"));
    await writeFile(join(worktreeA, "same.png"), new Uint8Array([...png, 10]));
    await writeFile(join(worktreeB, "same.png"), new Uint8Array([...png, 20]));

    const service = createFilePreviewService({
      homePath,
      canAccessHome: (principal) => principal.userId === "owner",
      resolveProjectRoot: async (principal, ref) => {
        if (principal.userId !== "owner" || ref.projectId !== "demo") return null;
        if (ref.worktreeId === "wt_a") return worktreeA;
        if (ref.worktreeId === "wt_b") return worktreeB;
        return projectPath;
      },
    });
    app = new Hono();
    app.route("/api/file-previews", createFilePreviewRoutes({
      service,
      getPrincipal: (c) => ({
        userId: c.req.header("authorization") === "Bearer owner" ? "owner" : "other",
        source: "jwt",
      }),
    }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves selected binary bytes without decoding the image as text", async () => {
    const response = await app.request(
      "/api/file-previews/content?kind=project&projectId=demo&path=output.png",
      { headers: { Range: "bytes=0-3", Authorization: "Bearer owner" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-3/${png.length}`);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png.slice(0, 4));
  });

  it("returns matching metadata, HEAD and If-Range behavior", async () => {
    const metadata = await app.request(
      "/api/file-previews/metadata?kind=project&projectId=demo&path=report.pdf",
      { headers: { Authorization: "Bearer owner" } },
    );
    expect(metadata.status).toBe(200);
    const descriptor = await metadata.json() as { kind: string; mimeType: string; version: string; sizeBytes: number };
    expect(descriptor).toMatchObject({ kind: "pdf", mimeType: "application/pdf" });

    const head = await app.request(
      "/api/file-previews/content?kind=project&projectId=demo&path=report.pdf",
      { method: "HEAD", headers: { Authorization: "Bearer owner" } },
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(descriptor.sizeBytes));
    expect(await head.text()).toBe("");

    const staleRange = await app.request(
      "/api/file-previews/content?kind=project&projectId=demo&path=report.pdf",
      { headers: { Authorization: "Bearer owner", Range: "bytes=0-3", "If-Range": '"stale"' } },
    );
    expect(staleRange.status).toBe(200);
    expect(await staleRange.text()).toBe("%PDF-1.7\nfixture");
  });

  it("preserves the selected historical worktree", async () => {
    const read = async (worktreeId: string) => new Uint8Array(await (await app.request(
      `/api/file-previews/content?kind=project&projectId=demo&worktreeId=${worktreeId}&path=same.png`,
      { headers: { Authorization: "Bearer owner" } },
    )).arrayBuffer());
    expect((await read("wt_a")).at(-1)).toBe(10);
    expect((await read("wt_b")).at(-1)).toBe(20);
  });

  it("denies another principal before resolving or opening a project file", async () => {
    const resolveProjectRoot = vi.fn(async () => projectPath);
    const isolated = new Hono();
    isolated.route("/api/file-previews", createFilePreviewRoutes({
      service: createFilePreviewService({
        homePath,
        canAccessHome: () => false,
        resolveProjectRoot: async (principal, ref) => {
          if (principal.userId !== "owner") return null;
          return resolveProjectRoot(principal, ref);
        },
      }),
      getPrincipal: () => ({ userId: "other", source: "jwt" }),
    }));
    const response = await isolated.request(
      "/api/file-previews/content?kind=project&projectId=demo&path=output.png",
    );
    expect(response.status).toBe(404);
    expect(resolveProjectRoot).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(projectPath);
  });

  it("returns an authentication error when no request principal is available", async () => {
    const isolated = new Hono();
    isolated.route("/api/file-previews", createFilePreviewRoutes({
      service: createFilePreviewService({
        homePath,
        canAccessHome: () => true,
        resolveProjectRoot: async () => projectPath,
      }),
      getPrincipal: () => { throw new MissingRequestPrincipalError(); },
    }));

    const response = await isolated.request(
      "/api/file-previews/metadata?kind=home&path=output.png",
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects traversal, outside-root symlinks and invalid ranges", async () => {
    const outside = join(root, "outside.png");
    await writeFile(outside, png);
    await symlink(outside, join(projectPath, "linked.png"));

    for (const url of [
      "/api/file-previews/content?kind=project&projectId=demo&path=..%2Foutside.png",
      "/api/file-previews/content?kind=project&projectId=demo&path=linked.png",
    ]) {
      const response = await app.request(url, { headers: { Authorization: "Bearer owner" } });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(root);
    }

    const invalidRange = await app.request(
      "/api/file-previews/content?kind=project&projectId=demo&path=output.png",
      { headers: { Authorization: "Bearer owner", Range: "bytes=0-1,4-5" } },
    );
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("content-range")).toBe(`bytes */${png.length}`);
  });

  it("downgrades a misleading active-content extension to unsupported", async () => {
    await writeFile(join(projectPath, "fake.png"), "<html><script>alert(1)</script></html>");
    const response = await app.request(
      "/api/file-previews/metadata?kind=project&projectId=demo&path=fake.png",
      { headers: { Authorization: "Bearer owner" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "unsupported",
      mimeType: "application/octet-stream",
      canDownload: true,
    });
  });

  it("keeps active SVG markup out of the image renderer", async () => {
    await writeFile(join(projectPath, "external.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/tracker.png"/></svg>');
    const response = await app.request(
      "/api/file-previews/metadata?kind=project&projectId=demo&path=external.svg",
      { headers: { Authorization: "Bearer owner" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "unsupported",
      mimeType: "application/octet-stream",
      canDownload: true,
    });
  });

  it("serves HTML source inertly even when its direct content URL is opened", async () => {
    await writeFile(join(projectPath, "page.html"), "<script>window.evil = true</script>");
    const response = await app.request(
      "/api/file-previews/content?kind=project&projectId=demo&path=page.html",
      { headers: { Authorization: "Bearer owner" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toContain("<script>");
  });

  it("rejects an opened descriptor whose path escaped the canonical home root", async () => {
    const outside = join(root, "outside-home.png");
    await writeFile(outside, png);
    const info = await lstat(outside, { bigint: true });
    await expect(openedPathIsAuthorized(outside, info, homePath)).resolves.toBe(false);
  });
});
