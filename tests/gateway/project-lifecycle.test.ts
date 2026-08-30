import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createProjectLifecycleService } from "../../packages/gateway/src/project-lifecycle.js";

describe("project lifecycle", () => {
  let homePath: string;
  const principal = { userId: "user_123", source: "jwt" as const };

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-project-lifecycle-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createScratch(name = "Customer app", slug = "customer-app") {
    const projectManager = createProjectManager({
      homePath,
      runCommand: vi.fn(),
      now: () => "2026-08-06T12:00:00.000Z",
    });
    const result = await projectManager.createProject({
      mode: "scratch",
      name,
      slug,
      ownerScope: { type: "user", id: principal.userId },
    });
    expect(result.ok).toBe(true);
    return projectManager;
  }

  it("archives and restores an idle project without deleting its data", async () => {
    const projectManager = await createScratch();
    await writeFile(join(homePath, "projects", "customer-app", "repo", "sentinel.txt"), "keep me");
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState: async () => undefined,
      now: () => "2026-08-06T13:00:00.000Z",
    });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", { type: "archive" }))
      .resolves.toMatchObject({ ok: true, action: "archive", project: { archivedAt: "2026-08-06T13:00:00.000Z" } });
    await expect(projectManager.listManagedProjects({
      visibility: "active",
      ownerScope: { type: "user", id: principal.userId },
    })).resolves.toMatchObject({ projects: [] });
    await expect(projectManager.getProject("customer-app")).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
    await expect(readFile(join(homePath, "projects", "customer-app", "repo", "sentinel.txt"), "utf-8"))
      .resolves.toBe("keep me");

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", { type: "restore" }))
      .resolves.toMatchObject({ ok: true, action: "restore", project: { slug: "customer-app" } });
    const restored = await projectManager.listManagedProjects({
      visibility: "active",
      ownerScope: { type: "user", id: principal.userId },
    });
    expect(restored.projects[0]?.archivedAt).toBeUndefined();
  });

  it("renames only the owner-visible project label while preserving its stable identity and files", async () => {
    const projectManager = await createScratch();
    await writeFile(join(homePath, "projects", "customer-app", "repo", "sentinel.txt"), "keep me");
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState: async () => undefined,
      now: () => "2026-08-06T13:00:00.000Z",
    });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", {
      type: "rename",
      name: "Customer workspace",
    })).resolves.toMatchObject({
      ok: true,
      action: "rename",
      project: {
        name: "Customer workspace",
        slug: "customer-app",
        updatedAt: "2026-08-06T12:00:00.000Z",
      },
    });
    await expect(readFile(join(homePath, "projects", "customer-app", "repo", "sentinel.txt"), "utf-8"))
      .resolves.toBe("keep me");
  });

  it("validates project rename labels at the lifecycle boundary", async () => {
    const projectManager = await createScratch();
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState: async () => undefined,
    });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", {
      type: "rename",
      name: "   ",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "invalid_request" } });
  });

  it("rejects archive and delete while project work is active without changing lifecycle state", async () => {
    const projectManager = await createScratch();
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [{ type: "session", label: "Agent session" }],
      cleanupRelatedState: async () => undefined,
    });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", { type: "archive" }))
      .resolves.toMatchObject({ ok: false, status: 409, error: { code: "project_active" } });
    await expect(service.applyProjectLifecycleAction(principal, "customer-app", {
      type: "delete",
      confirmation: "Customer app",
    })).resolves.toMatchObject({ ok: false, status: 409, error: { code: "project_active" } });

    const project = await projectManager.getProjectForLifecycle({
      slug: "customer-app",
      ownerScope: { type: "user", id: principal.userId },
    });
    expect(project).toMatchObject({ ok: true, project: { slug: "customer-app" } });
    if (project.ok) {
      expect(project.project.archivedAt).toBeUndefined();
      expect(project.project.deletingAt).toBeUndefined();
    }
  });

  it("requires the exact project name before permanent deletion", async () => {
    const projectManager = await createScratch();
    const cleanupRelatedState = vi.fn(async () => undefined);
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState,
    });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", {
      type: "delete",
      confirmation: "customer-app",
    })).resolves.toMatchObject({ ok: false, status: 400, error: { code: "confirmation_mismatch" } });
    expect(cleanupRelatedState).not.toHaveBeenCalled();
    await expect(stat(join(homePath, "projects", "customer-app"))).resolves.toBeTruthy();
  });

  it("deletes Matrix state but leaves an owner-controlled folder unchanged", async () => {
    const external = join(homePath, "workspaces", "external-source");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel.txt"), "owner-controlled");
    const projectManager = createProjectManager({ homePath, runCommand: vi.fn() });
    const created = await projectManager.createProject({
      mode: "folder",
      name: "External source",
      slug: "external-source",
      path: "workspaces/external-source",
      ownerScope: { type: "user", id: principal.userId },
    });
    expect(created.ok).toBe(true);
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState: async () => undefined,
      now: () => "2026-08-06T13:00:00.000Z",
    });

    await expect(service.applyProjectLifecycleAction(principal, "external-source", {
      type: "delete",
      confirmation: "External source",
    })).resolves.toEqual({ ok: true, action: "delete", projectSlug: "external-source" });

    await expect(stat(join(homePath, "projects", "external-source"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(external, "sentinel.txt"), "utf-8")).resolves.toBe("owner-controlled");
  });

  it("keeps a durable hidden tombstone when related cleanup fails and completes on retry", async () => {
    const projectManager = await createScratch();
    let attempts = 0;
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("private filesystem path");
      },
      now: () => "2026-08-06T13:00:00.000Z",
    });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", {
      type: "delete",
      confirmation: "Customer app",
    })).resolves.toMatchObject({ ok: false, status: 500, error: { code: "delete_incomplete", message: "Project deletion could not be completed" } });
    await expect(projectManager.listManagedProjects({
      visibility: "all",
      ownerScope: { type: "user", id: principal.userId },
    })).resolves.toMatchObject({ projects: [] });

    await expect(service.applyProjectLifecycleAction(principal, "customer-app", {
      type: "delete",
      confirmation: "Customer app",
    })).resolves.toEqual({ ok: true, action: "delete", projectSlug: "customer-app" });
  });

  it("resumes durable deletion tombstones during startup recovery", async () => {
    const projectManager = await createScratch();
    await projectManager.setProjectLifecycleState({
      slug: "customer-app",
      ownerScope: { type: "user", id: principal.userId },
      deletingAt: "2026-08-06T13:00:00.000Z",
    });
    const cleanupRelatedState = vi.fn(async () => undefined);
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState,
    });

    await expect(service.recoverDeletingProjects()).resolves.toEqual({ recovered: 1, failed: 0 });
    expect(cleanupRelatedState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "customer-app" }),
      expect.objectContaining({ userId: principal.userId }),
    );
    await expect(stat(join(homePath, "projects", "customer-app"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers deletion after a partial removal erases the managed config", async () => {
    const projectManager = await createScratch();
    await projectManager.setProjectLifecycleState({
      slug: "customer-app",
      ownerScope: { type: "user", id: principal.userId },
      deletingAt: "2026-08-06T13:00:00.000Z",
    });
    await writeFile(
      join(homePath, "projects", "customer-app", "repo", "residual.txt"),
      "partial deletion residue",
    );
    await rm(join(homePath, "system", "projects", "customer-app", "config.json"));

    const cleanupRelatedState = vi.fn(async () => undefined);
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState,
    });

    await expect(service.recoverDeletingProjects()).resolves.toEqual({ recovered: 1, failed: 0 });
    expect(cleanupRelatedState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "customer-app", deletingAt: "2026-08-06T13:00:00.000Z" }),
      expect.objectContaining({ userId: principal.userId }),
    );
    await expect(stat(join(homePath, "projects", "customer-app"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reveal whether another owner has a matching project slug", async () => {
    const projectManager = await createScratch();
    const service = createProjectLifecycleService({
      projectManager,
      findBlockers: async () => [],
      cleanupRelatedState: async () => undefined,
    });

    await expect(service.applyProjectLifecycleAction(
      { userId: "user_456", source: "jwt" },
      "customer-app",
      { type: "archive" },
    )).resolves.toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
  });
});
