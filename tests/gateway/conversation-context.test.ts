import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConversationContextResolver,
} from "../../packages/gateway/src/conversation-context.js";
import {
  createProjectManager,
  type ProjectConfig,
} from "../../packages/gateway/src/project-manager.js";

describe("conversation project context", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "conversation-context-"));
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  async function writeProject(
    project: ProjectConfig,
    options: { createWorkingDirectory?: boolean } = {},
  ): Promise<void> {
    await mkdir(join(homePath, "projects", project.slug), { recursive: true });
    if (options.createWorkingDirectory !== false) {
      await mkdir(project.localPath, { recursive: true });
    }
    await writeFile(
      join(homePath, "projects", project.slug, "config.json"),
      JSON.stringify(project),
      "utf-8",
    );
  }

  it("resolves a canonical GitHub project into separate internal and public context", async () => {
    const localPath = join(homePath, "projects", "matrix-os", "repo");
    const project: ProjectConfig = {
      id: "proj_matrix_os",
      slug: "matrix-os",
      name: "Matrix OS",
      kind: "github",
      localPath,
      addedAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
      github: {
        owner: "FinnaAI",
        repo: "matrix-os",
        htmlUrl: "https://github.com/FinnaAI/matrix-os",
        authState: "ok",
      },
    };
    await writeProject(project);
    const resolver = createConversationContextResolver(
      createProjectManager({ homePath, runCommand: vi.fn() }),
    );

    const resolved = await resolver.resolve(
      "matrix-os",
      { type: "user", id: "user_123" },
    );

    expect(resolved).toEqual({
      projection: {
        projectId: "matrix-os",
        projectName: "Matrix OS",
        projectKind: "github",
        repositoryLabel: "FinnaAI/matrix-os",
        status: "ready",
      },
      workingDirectory: await realpath(localPath),
    });
    expect(JSON.stringify(resolved?.projection)).not.toContain(localPath);
  });

  it("uses safe names for scratch and folder project repository labels", async () => {
    const projects: ProjectConfig[] = [
      {
        id: "proj_scratch",
        slug: "scratch-pad",
        name: "Scratch Pad",
        kind: "scratch",
        localPath: join(homePath, "projects", "scratch-pad", "repo"),
        addedAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        ownerScope: { type: "user", id: "user_123" },
      },
      {
        id: "proj_folder",
        slug: "client-notes",
        name: "Client Notes",
        kind: "folder",
        localPath: join(homePath, "workspaces", "client-notes"),
        addedAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        ownerScope: { type: "user", id: "user_123" },
      },
    ];
    for (const project of projects) await writeProject(project);
    const resolver = createConversationContextResolver(
      createProjectManager({ homePath, runCommand: vi.fn() }),
    );

    await expect(resolver.resolve("scratch-pad", projects[0]!.ownerScope))
      .resolves.toMatchObject({
        projection: {
          projectKind: "scratch",
          repositoryLabel: "Scratch Pad",
        },
      });
    await expect(resolver.resolve("client-notes", projects[1]!.ownerScope))
      .resolves.toMatchObject({
        projection: {
          projectKind: "folder",
          repositoryLabel: "Client Notes",
        },
      });
  });

  it("rejects missing, inactive, wrong-owner, and unsafe working contexts", async () => {
    const base: ProjectConfig = {
      id: "proj_unavailable",
      slug: "unavailable",
      name: "Unavailable",
      kind: "scratch",
      localPath: join(homePath, "projects", "unavailable", "repo"),
      addedAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    };
    const manager = createProjectManager({ homePath, runCommand: vi.fn() });
    const resolver = createConversationContextResolver(manager);

    await expect(resolver.resolve("missing", base.ownerScope)).resolves.toBeNull();

    await writeProject({ ...base, archivedAt: "2026-08-18T01:00:00.000Z" });
    await expect(resolver.resolve(base.slug, base.ownerScope)).resolves.toBeNull();

    await writeProject({ ...base, deletingAt: "2026-08-18T02:00:00.000Z" });
    await expect(resolver.resolve(base.slug, base.ownerScope)).resolves.toBeNull();

    await writeProject(base);
    await expect(resolver.resolve(base.slug, { type: "user", id: "user_456" }))
      .resolves.toBeNull();

    const missingPath = { ...base, slug: "missing-path", localPath: join(homePath, "gone") };
    await writeProject(missingPath, { createWorkingDirectory: false });
    await expect(resolver.resolve(missingPath.slug, missingPath.ownerScope)).resolves.toBeNull();

    const protectedPath = {
      ...base,
      slug: "protected-path",
      localPath: join(homePath, "system", "private-project"),
    };
    await writeProject(protectedPath);
    await expect(resolver.resolve(protectedPath.slug, protectedPath.ownerScope)).resolves.toBeNull();
  });
});
