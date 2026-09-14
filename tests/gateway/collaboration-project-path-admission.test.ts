import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyProjectPathAdmission } from "../../packages/gateway/src/collaboration/project-path-admission.js";

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

  it("rejects stored manifests above the bounded maintenance limit before project lookup", async () => {
    const listOwnerProjects = vi.fn(async () => []);
    const admission = createLegacyProjectPathAdmission({
      homePath,
      listOwnerProjects,
      projectOperationAdmission: { withLegacyAdmission: vi.fn() },
    });

    await expect(admission.withStoredPaths({
      ownerType: "personal",
      ownerId: "user_owner",
      paths: Array.from({ length: 50_001 }, () => "projects/outer/file.ts"),
      kind: "write",
    }, async () => "emptied")).rejects.toMatchObject({ code: "invalid" });
    expect(listOwnerProjects).not.toHaveBeenCalled();
  });
});
