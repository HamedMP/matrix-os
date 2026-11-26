import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFenceError } from "../../packages/gateway/src/collaboration/project-fence.js";
import { createLegacyProjectPathAdmission } from "../../packages/gateway/src/collaboration/project-path-admission.js";
import { createGatewayProjectPathAdmission } from "../../packages/gateway/src/server/project-routes.js";

describe("legacy project path admission", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-project-path-admission-"));
    await mkdir(join(homePath, "projects", "outer", "nested"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  it("locks every matching project in stable identity order", async () => {
    const order: string[] = [];
    const operation = vi.fn(async () => "done");
    const admission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects: async () => [
        { id: "proj_z", localPath: join(homePath, "projects", "outer") },
        { id: "proj_a", localPath: join(homePath, "projects", "outer", "nested") },
      ],
      projectOperationAdmission: {
        withLegacyAdmission: async (input, next) => {
          order.push(input.projectId);
          return next();
        },
      },
    });

    await expect(admission.withPaths({
      ownerType: "personal",
      ownerId: "user_owner",
      paths: ["projects/outer/nested/file.ts"],
      kind: "write",
    }, operation)).resolves.toBe("done");
    expect(order).toEqual(["proj_a", "proj_z"]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not consult collaboration authority for owner paths outside projects", async () => {
    const withLegacyAdmission = vi.fn();
    const admission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects: async () => [
        { id: "proj_a", localPath: join(homePath, "projects", "outer") },
      ],
      projectOperationAdmission: { withLegacyAdmission },
    });

    await expect(admission.withPaths({
      ownerType: "personal",
      ownerId: "user_owner",
      paths: ["downloads/file.txt"],
      kind: "write",
    }, async () => "ordinary")).resolves.toBe("ordinary");
    expect(withLegacyAdmission).not.toHaveBeenCalled();
  });

  it("admits complete stored manifests larger than the interactive request limit", async () => {
    const withLegacyAdmission = vi.fn(async (_input, operation: () => Promise<string>) => operation());
    const admission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects: async () => [
        { id: "proj_a", localPath: join(homePath, "projects", "outer") },
      ],
      projectOperationAdmission: { withLegacyAdmission },
    });

    await expect(admission.withStoredPaths({
      ownerType: "personal",
      ownerId: "user_owner",
      paths: Array.from({ length: 10_001 }, () => "projects/outer/file.ts"),
      kind: "write",
    }, async () => "emptied")).resolves.toBe("emptied");
    expect(withLegacyAdmission).toHaveBeenCalledTimes(1);
  });

  it("admits complete stored manifests above fifty thousand entries without copying per-path state", async () => {
    const withLegacyAdmission = vi.fn(async (_input, operation: () => Promise<string>) => operation());
    const listOwnerProjects = vi.fn(async () => [
      { id: "proj_a", localPath: join(homePath, "projects", "outer") },
    ]);
    const admission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects,
      projectOperationAdmission: { withLegacyAdmission },
    });

    await expect(admission.withStoredPaths({
      ownerType: "personal",
      ownerId: "user_owner",
      paths: Array.from({ length: 50_001 }, () => "projects/outer/file.ts"),
      kind: "write",
    }, async () => "emptied")).resolves.toBe("emptied");
    expect(listOwnerProjects).toHaveBeenCalledTimes(1);
    expect(withLegacyAdmission).toHaveBeenCalledTimes(1);
  });

  it("matches paths with an injected asynchronous resolver and leaves the paths it skips unfenced", async () => {
    const order: string[] = [];
    const resolveTarget = vi.fn(async (_home: string, path: string) => (path.startsWith("skip/") ? null : join(homePath, path)));
    const admission = createLegacyProjectPathAdmission({
      homePath,
      resolveTarget,
      listOwnerProjects: async () => [
        { id: "proj_a", localPath: join(homePath, "projects", "outer") },
        { id: "proj_b", localPath: join(homePath, "skip") },
      ],
      projectOperationAdmission: {
        withLegacyAdmission: async (input, next) => {
          order.push(input.projectId);
          return next();
        },
      },
    });

    await expect(admission.withPaths({
      ownerType: "personal",
      ownerId: "user_owner",
      paths: ["projects/outer/new/file.ts", "skip/file.ts"],
      kind: "write",
    }, async () => "done")).resolves.toBe("done");
    expect(resolveTarget.mock.calls.map(([, path]) => path)).toEqual(["projects/outer/new/file.ts", "skip/file.ts"]);
    expect(order).toEqual(["proj_a"]);
  });
  // Fault: owner file writes through a home reached by a link matched the
  // link's spelling, so a folder project recorded under its real root was
  // never consulted and the write ran unfenced.
  it("fences owner file writes through a linked home against projects recorded under the real root", async () => {
    const linkDir = await mkdtemp(join(tmpdir(), "matrix-project-path-link-"));
    try {
      const linkedHome = join(linkDir, "home");
      await symlink(homePath, linkedHome);
      const realRoot = join(await realpath(homePath), "projects", "outer");
      const operation = vi.fn(async () => "done");
      const admission = createGatewayProjectPathAdmission({
        homePath: linkedHome,
        projects: { listManagedProjects: async () => ({ projects: [{ id: "proj_folder", localPath: realRoot }] }) } as never,
        projectOperationAdmission: {
          withLegacyAdmission: async () => { throw new ProjectFenceError("scope_required"); },
        },
      });
      await expect(admission?.withPaths({
        ownerType: "personal", ownerId: "user_owner", paths: ["projects/outer/nested/file.ts"], kind: "write",
      }, operation)).rejects.toMatchObject({ code: "scope_required" });
      await expect(admission?.withPaths({
        ownerType: "personal", ownerId: "user_owner", paths: ["elsewhere.ts"], kind: "write",
      }, operation)).resolves.toBe("done");
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  });

  it("refuses, without running the operation, when the home location cannot be resolved", async () => {
    const operation = vi.fn(async () => "done");
    const admission = createLegacyProjectPathAdmission({
      homePath,
      resolveHomeLocation: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
      listOwnerProjects: async () => [],
      projectOperationAdmission: { withLegacyAdmission: async (_input, next) => next() },
    });
    await expect(admission.withPaths({
      ownerType: "personal", ownerId: "user_owner", paths: ["file.ts"], kind: "write",
    }, operation)).rejects.toMatchObject({ code: "unavailable" });
    expect(operation).not.toHaveBeenCalled();
  });
});
