/**
 * S12: the gateway entry point only names the owner resource wiring. The driver
 * construction, its project lookup and its close-on-failure path are proven here.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import {
  enableGatewaySharedResources,
  type OwnerAppRegistrySource,
  type OwnerResourceDriverHandle,
} from "../../packages/gateway/src/collaboration/resource-wiring.js";

type Project = { slug: string };

function projects(working: Record<string, string | null>) {
  return {
    async listManagedProjects(input: { visibility: "all"; ownerScope: { type: "user"; id: string } }) {
      const prefix = `${input.ownerScope.id}:`;
      return {
        projects: Object.keys(working)
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ id: key.slice(prefix.length), slug: key })),
      };
    },
    async getProjectById(ownerScope: { type: "user"; id: string }, projectId: string) {
      const key = `${ownerScope.id}:${projectId}`;
      return key in working
        ? { ok: true as const, project: { slug: key } }
        : { ok: false as const, status: 404, error: "missing" };
    },
    async resolveProjectWorkingDirectory(project: Project) {
      return working[project.slug] ?? null;
    },
  };
}

function registry(slugs: readonly string[]): OwnerAppRegistrySource {
  return {
    async get(slug: string) {
      return slugs.includes(slug)
        ? ({ slug, tables: { notes: { columns: {} } } } as unknown as Awaited<ReturnType<OwnerAppRegistrySource["get"]>>)
        : null;
    },
  };
}

function fakeDriver(closed: { count: number }): OwnerResourceDriverHandle {
  return {
    close: () => { closed.count += 1; },
  } as unknown as OwnerResourceDriverHandle;
}

describe("gateway shared resource wiring", () => {
  it("registers an unrelated folder when an archived project remains on disk, without sharing the archived checkout", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-archived-catalog-"));
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const ownerScope = { type: "user" as const, id: "owner_1" };
    let driver: OwnerResourceDriverHandle | undefined;
    try {
      const created = await manager.createProject({ mode: "scratch", name: "Old", slug: "old", ownerScope });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("Fixture project creation failed");
      await manager.setProjectLifecycleState({ slug: "old", ownerScope, archivedAt: "2026-09-30T00:00:00.000Z" });
      await mkdir(join(homePath, "shared", "team"), { recursive: true });
      driver = enableGatewaySharedResources({ runtime: { enableSharedResources: () => {} }, homePath,
        projects: manager, apps: registry([]), ownerId: ownerScope.id });
      await expect(driver.resolveOwnerNamespace!({ ownerId: ownerScope.id, kind: "folder", path: "shared/team" }))
        .resolves.toEqual({ projectId: null, path: "shared/team" });
      await expect(driver.resolveOwnerNamespace!({ ownerId: ownerScope.id, kind: "folder", path: "projects" }))
        .rejects.toMatchObject({ code: "forbidden" });
      await writeFile(join(created.project.localPath, "notes.txt"), "private archived project");
      await expect(driver.resolveOwnerNamespace!({ ownerId: ownerScope.id, kind: "file", path: "projects/old/repo/notes.txt" }))
        .resolves.toEqual({ projectId: created.project.id, path: "notes.txt" });
      // Boundary enumeration must not turn an archived checkout into readable shared data.
      await expect(driver.fingerprint({ ownerId: ownerScope.id, projectId: created.project.id, path: "notes.txt" }))
        .rejects.toMatchObject({ code: "unavailable" });
    } finally {
      driver?.close();
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it("resolves a project working directory through the gateway project manager", async () => {
    let resolveProjectWorkingDirectory: ((ownerId: string, projectId: string) => Promise<string | null>) | undefined;
    let listOwnedProjectIds: ((ownerId: string) => Promise<readonly string[]>) | undefined;
    const closed = { count: 0 };
    enableGatewaySharedResources({
      runtime: { enableSharedResources: () => {} },
      homePath: "/home/matrix/home",
      projects: projects({ "owner_1:proj_alpha": "/home/matrix/projects/alpha" }),
      ownerId: "owner_1",
      apps: registry(["notes"]),
      createDriver: (options) => {
        resolveProjectWorkingDirectory = options.resolveProjectWorkingDirectory;
        listOwnedProjectIds = options.listOwnedProjectIds;
        return fakeDriver(closed);
      },
    });
    // The driver lists exactly the asking owner's projects, never another owner's.
    expect(await listOwnedProjectIds?.("owner_1")).toEqual(["proj_alpha"]);
    expect(await listOwnedProjectIds?.("owner_2")).toEqual([]);
    expect(await resolveProjectWorkingDirectory?.("owner_1", "proj_alpha")).toBe("/home/matrix/projects/alpha");
    // An unknown project is a missing directory, never a throw into the driver.
    expect(await resolveProjectWorkingDirectory?.("owner_1", "proj_missing")).toBeNull();
    expect(closed.count).toBe(0);
  });

  it("refuses ambiguous or oversized project boundary inventories", async () => {
    for (const count of [2, 1_001]) {
      let boundary: ((ownerId: string, projectId: string) => Promise<string | null>) | undefined;
      const resolve = vi.fn(async () => "/home/matrix/home/projects/old/repo");
      const source = {
        ...projects({}),
        listManagedProjects: async () => ({ projects: Array.from({ length: count }, () => ({ id: "proj_old", slug: "old" })) }),
        resolveProjectWorkingDirectory: resolve,
      };
      enableGatewaySharedResources({ runtime: { enableSharedResources: () => {} }, homePath: "/home/matrix/home",
        projects: source, apps: registry([]), ownerId: "owner_1", createDriver: (options) => {
          boundary = options.resolveProjectBoundaryWorkingDirectory;
          return fakeDriver({ count: 0 });
        } });
      expect(await boundary?.("owner_1", "proj_old")).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it("closes the driver when the runtime refuses it", () => {
    const closed = { count: 0 };
    expect(() => enableGatewaySharedResources({
      runtime: { enableSharedResources: () => { throw new Error("already initialized"); } },
      homePath: "/home/matrix/home",
      projects: projects({}),
      ownerId: "owner_1",
      apps: registry([]),
      createDriver: () => fakeDriver(closed),
    })).toThrow("already initialized");
    // The driver owns a sweep timer; a refused runtime must not leave it running.
    expect(closed.count).toBe(1);
  });

  it("binds shared apps to the owner registry and refuses a missing one", async () => {
    const closed = { count: 0 };
    let resolveAppAssetRoot: ((ownerId: string, projectId: string | null, appId: string) => Promise<string | null>) | undefined;
    let appsFactory: unknown;
    enableGatewaySharedResources({
      runtime: { enableSharedResources: (input) => { appsFactory = input.appsFactory; } },
      homePath: "/home/matrix/home",
      projects: projects({}),
      ownerId: "owner_1",
      apps: registry(["notes"]),
      createDriver: (options) => {
        resolveAppAssetRoot = options.resolveAppAssetRoot;
        return fakeDriver(closed);
      },
    });
    // The app adapter is wired, not left to the entry point.
    expect(typeof appsFactory).toBe("function");
    // An app the owner never registered has no asset root, whatever the caller asks for.
    expect(await resolveAppAssetRoot?.("owner_1", null, "unregistered")).toBeNull();

    // A gateway without an app registry is misconfigured, not a gateway without apps.
    expect(() => enableGatewaySharedResources({
      runtime: { enableSharedResources: () => {} },
      homePath: "/home/matrix/home",
      projects: projects({}),
      ownerId: "owner_1",
      apps: null,
      createDriver: () => fakeDriver(closed),
    })).toThrow("Owner app registry is unavailable");
  });
});
