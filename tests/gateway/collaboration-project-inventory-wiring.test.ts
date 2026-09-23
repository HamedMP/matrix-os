import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRegistryIncarnation } from "../../packages/gateway/src/collaboration/app-incarnation.js";
import type { createOwnerResourceDriver } from "../../packages/gateway/src/collaboration/owner-resource-driver.js";
import {
  enableOwnerCollaborationSurfaces,
  type OwnerCollaborationRuntimeSurfaces,
  type OwnerCollaborationSurfaceDependencies,
} from "../../packages/gateway/src/collaboration/owner-runtime-surfaces.js";
import { recordingRuntime, startupOptions, type EnabledSurfaces } from "./collaboration-startup-harness.js";

// The startup extraction moved this composition out of the entry point, so the
// cross-module half is exercised through `constructOwnerCollaboration` against a
// recording runtime rather than asserted against the shape of the source text.
const surfaces: EnabledSurfaces = { order: [] };
vi.mock("../../packages/gateway/src/collaboration/wiring.js", async (importActual) => {
  const actual = await importActual<typeof import("../../packages/gateway/src/collaboration/wiring.js")>();
  return { ...actual, createGatewayCollaboration: async () => recordingRuntime(surfaces) };
});

const { constructOwnerCollaboration } = await import("../../packages/gateway/src/startup/collaboration.js");

const OWNER = "user_surface_owner";
const BOARD = { slug: "board", created_at: "2026-01-02T03:04:05.000Z", tables: { notes: {} } };

describe("production project share inventory wiring", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-inventory-wiring-"));
    surfaces.order = [];
    surfaces.git = undefined;
    surfaces.project = undefined;
    surfaces.resources = undefined;
  });

  afterEach(async () => {
    surfaces.resources?.driver.close();
    await rm(homePath, { recursive: true, force: true });
  });

  it("resolves canonical Chat roots through the Git driver the shared project reads from", async () => {
    // The owner-database startup builds the Chat execution roots and hands them to
    // collaboration construction, which builds the Git driver from them and composes
    // the surfaces. Both halves are observed here: the driver the Git broker receives
    // resolves project roots through those execution roots, and the inventory source
    // the broker reads is the same one the shared project surface serves from.
    const resolve = vi.fn(async () => ({ primaryWorkspaceRoot: homePath }));
    const construction = await constructOwnerCollaboration(startupOptions(homePath, {
      ownerChatExecutionRoots: { resolve } as never,
    }));
    expect(construction.ok).toBe(true);
    const git = surfaces.git as { driver: { getGitSetup(input: unknown): Promise<unknown> }; source: unknown };
    const project = surfaces.project as { homePath: string; inventorySource: unknown };
    expect(git.source).toBe(project.inventorySource);
    expect(project.homePath).toBe(homePath);
    expect(surfaces.order.indexOf("git")).toBeLessThan(surfaces.order.indexOf("project"));

    // The directory is not a repository, so the broker reports unavailable — but only
    // after reaching the owner's canonical Chat execution roots for that project.
    expect(await git.driver.getGitSetup({ ownerId: "user_startup_owner", projectId: "project_alpha" }))
      .toMatchObject({ identity: { status: "unavailable" }, forgeCredential: { status: "unavailable" } });
    expect(resolve).toHaveBeenCalledWith(
      { type: "personal", ownerId: "user_startup_owner" },
      { kind: "project", projectId: "project_alpha" },
    );
  });

  it("keeps the gateway entry point out of the collaboration surface composition", async () => {
    const server = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    expect(server).toContain("initializeOwnerDatabaseServices({");
    for (const moved of [
      "createOwnerResourceDriver(",
      "createGatewayProjectInventorySource(",
      "createProjectChatRootInventory(",
      "createAppInstanceAdapter(",
      "createScopedAppBridge(",
    ]) {
      expect(server).not.toContain(moved);
    }
  });
});

describe("owner collaboration surface composition", () => {
  let homePath: string;
  let calls: { resources: Record<string, unknown>[]; git: Record<string, unknown>[]; project: Record<string, unknown>[] };
  let runtime: OwnerCollaborationRuntimeSurfaces;

  function dependencies(overrides: Partial<OwnerCollaborationSurfaceDependencies> = {}): OwnerCollaborationSurfaceDependencies {
    return {
      homePath,
      ownerId: OWNER,
      appRegistry: { get: async (appId: string) => appId === BOARD.slug ? BOARD : null } as unknown as OwnerCollaborationSurfaceDependencies["appRegistry"],
      canvasRepository: { kysely: {} } as unknown as OwnerCollaborationSurfaceDependencies["canvasRepository"],
      chatRepository: { kysely: {} } as unknown as OwnerCollaborationSurfaceDependencies["chatRepository"],
      chatExecutionRoots: { resolve: async () => ({ primaryWorkspaceRoot: homePath }) } as unknown as OwnerCollaborationSurfaceDependencies["chatExecutionRoots"],
      projectManager: {
        listManagedProjects: async () => ({ projects: [] }),
        getProjectById: async () => ({ ok: false as const }),
        resolveProjectWorkingDirectory: () => null,
      } as unknown as OwnerCollaborationSurfaceDependencies["projectManager"],
      projectGitDriver: { getGitSetup: async () => null } as unknown as OwnerCollaborationSurfaceDependencies["projectGitDriver"],
      terminalWorkspaces: { listWorkspaces: async () => [] } as unknown as OwnerCollaborationSurfaceDependencies["terminalWorkspaces"],
      ...overrides,
    };
  }

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-owner-surfaces-"));
    calls = { resources: [], git: [], project: [] };
    runtime = {
      enableSharedResources: (input: Record<string, unknown>) => { calls.resources.push(input); },
      enableProjectGit: (input: Record<string, unknown>) => { calls.git.push(input); },
      enableSharedProject: async (input: Record<string, unknown>) => { calls.project.push(input); return "enabled"; },
    } as unknown as OwnerCollaborationRuntimeSurfaces;
  });

  afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

  it("drives the resource driver and the Git broker from the owner app registry", async () => {
    await enableOwnerCollaborationSurfaces(runtime, dependencies());
    expect(calls.resources).toHaveLength(1);
    const driver = calls.resources[0]!.driver as ReturnType<typeof createOwnerResourceDriver>;
    try {
      expect(await driver.inspect!({ ownerId: OWNER, projectId: null, kind: "app", path: BOARD.slug }))
        .toEqual({ incarnation: appRegistryIncarnation(BOARD) });
      await expect(driver.inspect!({ ownerId: OWNER, projectId: null, kind: "app", path: "absent" }))
        .rejects.toMatchObject({ code: "not_found" });
      // The registry belongs to one owner; no other owner resolves a registered app.
      await expect(driver.inspect!({ ownerId: "user_other", projectId: null, kind: "app", path: BOARD.slug }))
        .rejects.toMatchObject({ code: "not_found" });
    } finally {
      driver.close();
    }
    expect(calls.git[0]!.source).toBe(calls.project[0]!.inventorySource);
    expect(calls.project[0]!.homePath).toBe(homePath);
  });

  it("refuses to compose without the owner registries the surfaces read from", async () => {
    await expect(enableOwnerCollaborationSurfaces(runtime, dependencies({ appRegistry: null })))
      .rejects.toThrow("Owner app registry is unavailable");
    await expect(enableOwnerCollaborationSurfaces(runtime, dependencies({ canvasRepository: null })))
      .rejects.toThrow("Owner canvas repository is unavailable");
    expect(calls.resources).toHaveLength(0);
  });

  it("closes the resource driver when the runtime refuses the shared resources", async () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const failing = {
      ...runtime,
      enableSharedResources: (input: Record<string, unknown>) => { calls.resources.push(input); throw new Error("refused"); },
    } as unknown as OwnerCollaborationRuntimeSurfaces;
    await expect(enableOwnerCollaborationSurfaces(failing, dependencies())).rejects.toThrow("refused");
    expect(clear).toHaveBeenCalled();
    expect(calls.git).toHaveLength(0);
    expect(calls.project).toHaveLength(0);
    clear.mockRestore();
  });
});
