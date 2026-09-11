import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppRuntimeRoutes } from "../../packages/gateway/src/server/app-runtime-routes.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { ProjectFenceError } from "../../packages/gateway/src/collaboration/project-fence.js";
import { createLegacyProjectPathAdmission } from "../../packages/gateway/src/collaboration/project-path-admission.js";

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
});
