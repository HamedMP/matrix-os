import { mkdtemp, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { reconcileProjectIdentityIndex } from "../../packages/gateway/src/project-identity-index.js";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";

describe("project-manager immutable identity", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-project-identity-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves active owner projects by immutable ID instead of mutable slug", async () => {
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const created = await manager.createProject({
      mode: "scratch",
      name: "Immutable workspace",
      slug: "mutable-slug",
      ownerScope: { type: "user", id: "user_123" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(manager.getProjectById(
      { type: "user", id: "user_123" },
      created.project.id,
    )).resolves.toMatchObject({
      ok: true,
      project: { id: created.project.id, slug: "mutable-slug" },
    });
    await expect(manager.getProjectById(
      { type: "user", id: "another_owner" },
      created.project.id,
    )).resolves.toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
  });

  it("fails closed when active or archived ProjectConfigs reuse an owner ID", async () => {
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const ownerScope = { type: "user" as const, id: "user_123" };
    const first = await manager.createProject({ mode: "scratch", name: "First", slug: "first", ownerScope });
    const second = await manager.createProject({ mode: "scratch", name: "Second", slug: "second", ownerScope });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const secondConfigPath = join(homePath, "system", "projects", "second", "config.json");
    const secondConfig = JSON.parse(await readFile(secondConfigPath, "utf-8"));
    await atomicWriteJson(secondConfigPath, {
      ...secondConfig,
      id: first.project.id,
      archivedAt: "2026-08-25T15:00:00.000Z",
    });

    await expect(manager.getProjectById(ownerScope, first.project.id)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "project_identity_conflict" },
    });
  });

  it("bounds index reconciliation before reading excess project configs", async () => {
    const readProject = vi.fn();
    await expect(reconcileProjectIdentityIndex({
      ownerScope: { type: "user", id: "user_123" },
      projectId: "proj_target",
      maxEntries: 2,
      listSlugs: async () => ["one", "two", "three"],
      readProject,
    })).resolves.toEqual({ kind: "capacity" });
    expect(readProject).not.toHaveBeenCalled();
  });
});
