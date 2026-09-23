/**
 * S12: the gateway entry point only names the owner resource wiring. The driver
 * construction, its project lookup and its close-on-failure path are proven here.
 */
import { describe, expect, it } from "vitest";
import {
  enableGatewaySharedResources,
  type OwnerResourceDriverHandle,
} from "../../packages/gateway/src/collaboration/resource-wiring.js";

type Project = { slug: string };

function projects(working: Record<string, string | null>) {
  return {
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

function fakeDriver(closed: { count: number }): OwnerResourceDriverHandle {
  return {
    close: () => { closed.count += 1; },
  } as unknown as OwnerResourceDriverHandle;
}

describe("gateway shared resource wiring", () => {
  it("resolves a project working directory through the gateway project manager", async () => {
    let resolveProjectWorkingDirectory: ((ownerId: string, projectId: string) => Promise<string | null>) | undefined;
    const closed = { count: 0 };
    enableGatewaySharedResources({
      runtime: { enableSharedResources: () => {} },
      homePath: "/home/matrix/home",
      projects: projects({ "owner_1:proj_alpha": "/home/matrix/projects/alpha" }),
      createDriver: (options) => {
        resolveProjectWorkingDirectory = options.resolveProjectWorkingDirectory;
        return fakeDriver(closed);
      },
    });
    expect(await resolveProjectWorkingDirectory?.("owner_1", "proj_alpha")).toBe("/home/matrix/projects/alpha");
    // An unknown project is a missing directory, never a throw into the driver.
    expect(await resolveProjectWorkingDirectory?.("owner_1", "proj_missing")).toBeNull();
    expect(closed.count).toBe(0);
  });

  it("closes the driver when the runtime refuses it", () => {
    const closed = { count: 0 };
    expect(() => enableGatewaySharedResources({
      runtime: { enableSharedResources: () => { throw new Error("already initialized"); } },
      homePath: "/home/matrix/home",
      projects: projects({}),
      createDriver: () => fakeDriver(closed),
    })).toThrow("already initialized");
    // The driver owns a sweep timer; a refused runtime must not leave it running.
    expect(closed.count).toBe(1);
  });
});
