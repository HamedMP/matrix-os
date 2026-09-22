import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createProjectRegistry } from "../../packages/gateway/src/project-registry.js";

import { ProjectFenceError } from "../../packages/gateway/src/collaboration/project-fence.js";

const ownerScope = { type: "user" as const, id: "owner" };
describe("project metadata route", () => {
  let homePath: string;
  beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "project-metadata-")); });
  afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });
  async function setup() {
    const manager = createProjectManager({ homePath });
    const created = await manager.createProject({ mode: "scratch", slug: "alpha", name: "Alpha", ownerScope });
    if (!created.ok) throw new Error("fixture failed");
    const app = createWorkspaceRoutes({ homePath, getOwnerScope: () => ownerScope });
    const patch = (body: unknown, slug = "alpha") => app.request(`/api/projects/${slug}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { manager, original: created.project, app, patch };
  }
  it("persists pin and edits without changing identity or path", async () => {
    const { manager, original, patch } = await setup();
    expect((await patch({ pinned: true, name: " New name ", description: " Notes " })).status).toBe(200);
    const current = await manager.getProject("alpha", ownerScope);
    expect(current).toMatchObject({ ok: true, project: { id: original.id, slug: "alpha", localPath: original.localPath, name: "New name", description: "Notes", pinned: true } });
    expect((await patch({ pinned: false, description: "" })).status).toBe(200);
    expect(await manager.getProject("alpha", ownerScope)).toMatchObject({ project: { pinned: false, description: "" } });
  });
  it("serializes independent simultaneous patches", async () => {
    const { manager, patch } = await setup();
    const responses = await Promise.all([patch({ pinned: true }), patch({ name: "Renamed" })]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(await manager.getProject("alpha", ownerScope)).toMatchObject({ project: { pinned: true, name: "Renamed" } });
  });
  it.each([{}, { name: " " }, { name: "x".repeat(129) }, { description: "x".repeat(1001) }, { pinned: "yes" }, { localPath: "/etc" }, { id: "other" }])("rejects invalid patch %j", async body => {
    const { patch } = await setup();
    expect((await patch(body)).status).toBe(400);
  });
  it("rejects oversized bodies and malformed slugs", async () => {
    const { patch } = await setup();
    expect((await patch({ description: "x".repeat(65536) })).status).toBe(413);
    expect((await patch({ pinned: true }, "INVALID")).status).toBe(400);
  });
  it("denies another owner and unauthenticated requests", async () => {
    await setup();
    const request = { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"pinned":true}' };
    const other = createWorkspaceRoutes({ homePath, getOwnerScope: () => ({ type: "user", id: "other" }) });
    expect((await other.request("/api/projects/alpha", request)).status).toBe(404);
    const noPrincipal = createWorkspaceRoutes({ homePath });
    expect((await noPrincipal.request("/api/projects/alpha", request)).status).not.toBe(200);
  });
  it("applies collaboration write admission before mutation", async () => {
    const { original, manager } = await setup();
    const withLegacyAdmission = vi.fn(async () => { throw new ProjectFenceError("scope_required"); });
    const app = createWorkspaceRoutes({ homePath, getOwnerScope: () => ownerScope, projectOperationAdmission: { withLegacyAdmission } as never });
    const response = await app.request("/api/projects/alpha", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"pinned":true}' });
    expect(response.status).toBe(409);
    expect(withLegacyAdmission).toHaveBeenCalledWith({ ownerType: "personal", ownerId: "owner", projectId: original.id, kind: "write" }, expect.any(Function));
    expect(await manager.getProject("alpha", ownerScope)).toMatchObject({ project: { name: "Alpha" } });
  });
  it("does not mutate a replacement created after admission resolves the project identity", async () => {
    const { original, manager } = await setup();
    const replacement = {
      ...original,
      id: "proj_replacement",
      name: "Replacement",
      updatedAt: new Date().toISOString(),
    };
    const registry = createProjectRegistry({ homePath });
    const withLegacyAdmission = vi.fn(async (_input: unknown, operation: () => Promise<unknown>) => {
      await registry.writeConfig("alpha", replacement);
      return operation();
    });
    const app = createWorkspaceRoutes({
      homePath,
      getOwnerScope: () => ownerScope,
      projectOperationAdmission: { withLegacyAdmission } as never,
    });

    const response = await app.request("/api/projects/alpha", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"pinned":true}',
    });

    expect(response.status).toBe(409);
    expect(withLegacyAdmission).toHaveBeenCalledWith({
      ownerType: "personal",
      ownerId: "owner",
      projectId: original.id,
      kind: "write",
    }, expect.any(Function));
    const current = await manager.getProject("alpha", ownerScope);
    expect(current).toMatchObject({ project: { id: replacement.id, name: "Replacement" } });
    expect(current).not.toHaveProperty("project.pinned");
  });
  it.each(["archivedAt", "deletingAt"])("rejects %s projects", async field => {
    const { original, patch } = await setup();
    await createProjectRegistry({ homePath }).writeConfig("alpha", { ...original, [field]: new Date().toISOString() });
    expect((await patch({ name: "Hidden" })).status).toBe(404);
  });
});
