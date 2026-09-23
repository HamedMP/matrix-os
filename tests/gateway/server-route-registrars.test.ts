import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppRuntimeRoutes } from "../../packages/gateway/src/server/app-runtime-routes.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { ProjectFenceError } from "../../packages/gateway/src/collaboration/project-fence.js";
import { createLegacyProjectPathAdmission } from "../../packages/gateway/src/collaboration/project-path-admission.js";
import type { FilePreviewService } from "../../packages/gateway/src/file-preview-service.js";

describe("gateway server route registrars", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("wires app runtime boundary validation through the extracted registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-app-routes-"));
    cleanupPaths.push(homePath);
    const app = new Hono();
    const processManager = registerAppRuntimeRoutes(app, {
      homePath,
      appSessionMasterSecret: "test-secret-with-enough-entropy",
      devAppAuthBypass: true,
      publicHost: "localhost",
      onAppError: () => {},
    });

    try {
      const res = await app.request("/api/apps/bad!/manifest");

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid slug" });
    } finally {
      await processManager.shutdownAll();
    }
  });

  it("wires file route query validation through the extracted registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-file-routes-"));
    cleanupPaths.push(homePath);
    const app = new Hono();
    registerFileRoutes(app, { homePath });

    const res = await app.request("/api/files/search");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "q required" });
  });

  it("mounts the authenticated shared preview routes through the file registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-file-preview-routes-"));
    cleanupPaths.push(homePath);
    const service: FilePreviewService = {
      resolvePreview: vi.fn(async (_principal, resource) => ({
        resource,
        name: "output.png",
        mimeType: "image/png",
        sizeBytes: 12,
        kind: "image",
        version: "file_fixture",
        canDownload: true,
      })),
      openPreviewContent: vi.fn(async () => new Response("fixture")),
    };
    const app = new Hono();
    registerFileRoutes(app, {
      homePath,
      filePreviewService: service,
      getPrincipal: () => ({ userId: "user_owner", source: "jwt" }),
    });

    const response = await app.request(
      "/api/file-previews/metadata?kind=home&path=output.png",
    );

    expect(response.status).toBe(200);
    expect(service.resolvePreview).toHaveBeenCalledWith(
      { userId: "user_owner", source: "jwt" },
      { kind: "home", path: "output.png" },
    );
  });

  it("blocks legacy file writes inside a shared project root", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-file-fence-"));
    cleanupPaths.push(homePath);
    const projectRoot = join(homePath, "projects", "repo");
    await mkdir(projectRoot, { recursive: true });
    const projectOperationAdmission = {
      withLegacyAdmission: vi.fn(async () => {
        throw new ProjectFenceError("scope_required");
      }),
    };
    const app = new Hono();
    const projectPathAdmission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects: async () => [{ id: "proj_repo", localPath: projectRoot }],
      projectOperationAdmission,
    });
    registerFileRoutes(app, {
      homePath,
      getOwnerId: () => "user_owner",
      projectPathAdmission,
    });

    const response = await app.request("/api/files/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "projects/repo/blocked.txt", content: "blocked" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Use the shared project route" });
    expect(projectOperationAdmission.withLegacyAdmission).toHaveBeenCalledWith({
      ownerType: "personal",
      ownerId: "user_owner",
      projectId: "proj_repo",
      kind: "write",
    }, expect.any(Function));
    await expect(stat(join(projectRoot, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("empties a large stored trash manifest under one deduplicated project admission", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-trash-fence-"));
    cleanupPaths.push(homePath);
    const projectRoot = join(homePath, "projects", "repo");
    const trashRoot = join(homePath, ".trash");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(trashRoot, { recursive: true });
    const entries = Array.from({ length: 65 }, (_, index) => ({
      name: `file-${index}.txt`,
      originalPath: `projects/repo/file-${index}.txt`,
      deletedAt: new Date(0).toISOString(),
      trashPath: `.trash/file-${index}.txt`,
    }));
    await Promise.all(entries.map((entry) => writeFile(join(homePath, entry.trashPath), entry.name)));
    await writeFile(join(trashRoot, ".manifest.json"), JSON.stringify(entries));
    const projectOperationAdmission = {
      withLegacyAdmission: vi.fn(async (_input, operation: () => Promise<Response>) => operation()),
    };
    const app = new Hono();
    const projectPathAdmission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects: async () => [{ id: "proj_repo", localPath: projectRoot }],
      projectOperationAdmission,
    });
    registerFileRoutes(app, {
      homePath,
      getOwnerId: () => "user_owner",
      projectPathAdmission,
    });

    const response = await app.request("/api/files/trash/empty", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deleted: 65 });
    expect(projectOperationAdmission.withLegacyAdmission).toHaveBeenCalledTimes(1);
  });
});
