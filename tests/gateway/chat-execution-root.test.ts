import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatExecutionRootError,
  createChatExecutionRootResolver,
  type ChatExecutionRootProject,
  type ChatExecutionRootWorktree,
} from "../../packages/gateway/src/chat/execution-root.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";

const owner = { type: "personal" as const, ownerId: "user_owner" };
const roots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function project(input: Partial<ChatExecutionRootProject> & Pick<ChatExecutionRootProject, "localPath">): ChatExecutionRootProject {
  return {
    id: "proj_immutable",
    slug: "matrix-os-renamed",
    localPath: input.localPath,
    ...input,
  };
}

function worktree(input: Partial<ChatExecutionRootWorktree> & Pick<ChatExecutionRootWorktree, "path">): ChatExecutionRootWorktree {
  return {
    id: "wt_abc123def456",
    projectSlug: "matrix-os-renamed",
    path: input.path,
    createdAt: "2026-08-25T09:00:00.000Z",
    ...input,
  };
}

describe("canonical Chat execution-root resolver", () => {
  it("resolves a project by immutable ID and supports an approved folder root", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const externalFolder = await temporaryDirectory("matrix-owner-folder-");
    let projectRecord = project({ localPath: externalFolder });
    const getProjectById = vi.fn(async () => ({ ok: true as const, project: projectRecord }));
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById,
        resolveProjectWorkingDirectory: vi.fn(async () => externalFolder),
      },
      worktrees: { getWorktree: vi.fn() },
    });

    const resolved = await resolver.resolve(owner, { kind: "project", projectId: projectRecord.id });

    expect(getProjectById).toHaveBeenCalledWith(
      { type: "user", id: owner.ownerId },
      projectRecord.id,
    );
    expect(resolved).toEqual({
      ref: { kind: "project", projectId: projectRecord.id },
      primaryWorkspaceRoot: await realpath(externalFolder),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(resolved)).not.toContain("user_owner");

    projectRecord = { ...projectRecord, slug: "renamed-again" };
    await expect(resolver.revalidate(owner, {
      ref: resolved.ref,
      fingerprint: resolved.fingerprint,
    })).resolves.toEqual(resolved);
  });

  it("fails closed when project authority is revoked during revalidation", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const externalFolder = await temporaryDirectory("matrix-owner-folder-");
    const projectRecord = project({ localPath: externalFolder });
    let active = true;
    let revokeDuringPathValidation = false;
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById: vi.fn(async () => active
          ? { ok: true as const, project: projectRecord }
          : { ok: false as const, status: 404, error: { code: "not_found" } }),
        resolveProjectWorkingDirectory: vi.fn(async () => {
          if (revokeDuringPathValidation) active = false;
          return externalFolder;
        }),
      },
      worktrees: { getWorktree: vi.fn() },
    });
    const first = await resolver.resolve(owner, {
      kind: "project",
      projectId: projectRecord.id,
    });

    revokeDuringPathValidation = true;
    await expect(resolver.revalidate(owner, first)).rejects.toEqual(
      new ChatExecutionRootError("invalid_root"),
    );
  });

  it("wires the production ProjectManager and WorktreeManager through the same seam", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const projectManager = createProjectManager({ homePath, runCommand: vi.fn() });
    const createdProject = await projectManager.createProject({
      mode: "scratch",
      name: "Canonical Chat",
      slug: "canonical-chat",
      ownerScope: { type: "user", id: owner.ownerId },
    });
    expect(createdProject.ok).toBe(true);
    if (!createdProject.ok) return;
    const worktreeManager = createWorktreeManager({
      homePath,
      runCommand: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          const separator = args.indexOf("--");
          const path = separator >= 0 ? args[separator + 1] : undefined;
          if (path) await mkdir(path, { recursive: true });
        }
        return { stdout: "", stderr: "" };
      }),
    });
    const createdWorktree = await worktreeManager.createWorktree({
      projectSlug: createdProject.project.slug,
      branch: "feature/chat-root",
      ownerScope: { type: "user", id: owner.ownerId },
    });
    expect(createdWorktree.ok).toBe(true);
    if (!createdWorktree.ok) return;
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: projectManager,
      worktrees: worktreeManager,
    });

    const projectRoot = await resolver.resolve(owner, {
      kind: "project",
      projectId: createdProject.project.id,
    });
    const worktreeRoot = await resolver.resolve(owner, {
      kind: "worktree",
      projectId: createdProject.project.id,
      worktreeId: createdWorktree.worktree.id,
    });

    expect(projectRoot.primaryWorkspaceRoot).toBe(await realpath(createdProject.project.localPath));
    expect(worktreeRoot.primaryWorkspaceRoot).toBe(await realpath(createdWorktree.worktree.path));
    expect(projectRoot.fingerprint).not.toBe(worktreeRoot.fingerprint);
  });

  it("resolves a folder project connected directly under projects", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const checkout = join(homePath, "projects", "matrix-os");
    await mkdir(checkout, { recursive: true });
    const projectManager = createProjectManager({ homePath, runCommand: vi.fn() });
    const createdProject = await projectManager.createProject({
      mode: "folder",
      name: "Matrix OS",
      slug: "matrix-os",
      path: "projects/matrix-os",
      ownerScope: { type: "user", id: owner.ownerId },
    });
    expect(createdProject.ok).toBe(true);
    if (!createdProject.ok) return;
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: projectManager,
      worktrees: createWorktreeManager({ homePath, runCommand: vi.fn() }),
    });

    const resolved = await resolver.resolve(owner, {
      kind: "project",
      projectId: createdProject.project.id,
    });

    expect(resolved.primaryWorkspaceRoot).toBe(await realpath(checkout));
  });

  it("binds worktree fingerprints to exact project and WorktreeRecord provenance", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const projectPath = await temporaryDirectory("matrix-project-root-");
    const projectRecord = project({ localPath: projectPath });
    const firstWorktreePath = join(homePath, "worktrees", projectRecord.slug, "wt_abc123def456");
    await mkdir(firstWorktreePath, { recursive: true });
    let worktreeRecord = worktree({ path: firstWorktreePath });
    const getWorktree = vi.fn(async () => ({ ok: true as const, worktree: worktreeRecord }));
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById: vi.fn(async () => ({ ok: true as const, project: projectRecord })),
        resolveProjectWorkingDirectory: vi.fn(async () => projectPath),
      },
      worktrees: { getWorktree },
    });
    const ref = {
      kind: "worktree" as const,
      projectId: projectRecord.id,
      worktreeId: worktreeRecord.id,
    };

    const first = await resolver.resolve(owner, ref);
    expect(getWorktree).toHaveBeenCalledWith(
      projectRecord.slug,
      worktreeRecord.id,
      { type: "user", id: owner.ownerId },
    );
    await expect(resolver.revalidate(owner, {
      ref,
      fingerprint: first.fingerprint,
    })).resolves.toEqual(first);

    worktreeRecord = worktree({
      path: firstWorktreePath,
      createdAt: "2026-08-25T10:00:00.000Z",
    });
    await expect(resolver.revalidate(owner, {
      ref,
      fingerprint: first.fingerprint,
    })).rejects.toEqual(new ChatExecutionRootError("root_changed"));
  });

  it("fails closed when worktree authority is revoked during revalidation", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const projectPath = await temporaryDirectory("matrix-project-root-");
    const projectRecord = project({ localPath: projectPath });
    const worktreePath = join(homePath, "worktrees", projectRecord.slug, "wt_abc123def456");
    await mkdir(worktreePath, { recursive: true });
    let active = true;
    let revokeWhenPathIsRead = false;
    const worktreeRecord: ChatExecutionRootWorktree = {
      id: "wt_abc123def456",
      projectSlug: projectRecord.slug,
      get path() {
        if (revokeWhenPathIsRead) active = false;
        return worktreePath;
      },
      createdAt: "2026-08-25T09:00:00.000Z",
    };
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById: vi.fn(async () => ({ ok: true as const, project: projectRecord })),
        resolveProjectWorkingDirectory: vi.fn(async () => projectPath),
      },
      worktrees: {
        getWorktree: vi.fn(async () => active
          ? { ok: true as const, worktree: worktreeRecord }
          : { ok: false as const, status: 404, error: { code: "not_found" } }),
      },
    });
    const first = await resolver.resolve(owner, {
      kind: "worktree",
      projectId: projectRecord.id,
      worktreeId: worktreeRecord.id,
    });

    revokeWhenPathIsRead = true;
    await expect(resolver.revalidate(owner, first)).rejects.toEqual(
      new ChatExecutionRootError("invalid_root"),
    );
  });

  it("fails closed when project authority is revoked during the final worktree reload", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const projectPath = await temporaryDirectory("matrix-project-root-");
    const projectRecord = project({ localPath: projectPath });
    const worktreePath = join(homePath, "worktrees", projectRecord.slug, "wt_abc123def456");
    await mkdir(worktreePath, { recursive: true });
    const worktreeRecord = worktree({ path: worktreePath });
    let projectActive = true;
    let revokeDuringFinalWorktreeReload = false;
    let worktreeReloads = 0;
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById: vi.fn(async () => projectActive
          ? { ok: true as const, project: projectRecord }
          : { ok: false as const, status: 404, error: { code: "not_found" } }),
        resolveProjectWorkingDirectory: vi.fn(async () => projectPath),
      },
      worktrees: {
        getWorktree: vi.fn(async () => {
          worktreeReloads += 1;
          if (revokeDuringFinalWorktreeReload && worktreeReloads === 2) {
            projectActive = false;
          }
          return { ok: true as const, worktree: worktreeRecord };
        }),
      },
    });
    const first = await resolver.resolve(owner, {
      kind: "worktree",
      projectId: projectRecord.id,
      worktreeId: worktreeRecord.id,
    });

    revokeDuringFinalWorktreeReload = true;
    worktreeReloads = 0;
    await expect(resolver.revalidate(owner, first)).rejects.toEqual(
      new ChatExecutionRootError("invalid_root"),
    );
  });

  it("rejects mismatched metadata, direct or ancestor symlinks, and unavailable authority", async () => {
    const homePath = await temporaryDirectory("matrix-execution-root-home-");
    const projectPath = await temporaryDirectory("matrix-project-root-");
    const targetPath = await temporaryDirectory("matrix-worktree-target-");
    const insideTargetPath = join(homePath, "system", "redirected-worktree");
    await mkdir(join(insideTargetPath, "wt_abc123def456"), { recursive: true });
    const projectRecord = project({ localPath: projectPath });
    const managedParent = join(homePath, "worktrees", projectRecord.slug);
    const symlinkRoot = join(managedParent, "wt_abc123def456");
    await mkdir(managedParent, { recursive: true });
    await symlink(targetPath, symlinkRoot);
    let response:
      | { ok: true; worktree: ChatExecutionRootWorktree }
      | { ok: false; status: number; error: unknown } = {
        ok: true,
        worktree: worktree({ path: symlinkRoot, projectSlug: "wrong-project" }),
      };
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById: vi.fn(async () => ({ ok: true as const, project: projectRecord })),
        resolveProjectWorkingDirectory: vi.fn(async () => projectPath),
      },
      worktrees: { getWorktree: vi.fn(async () => response) },
    });
    const ref = { kind: "worktree" as const, projectId: projectRecord.id, worktreeId: "wt_abc123def456" };

    await expect(resolver.resolve(owner, ref)).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    response = {
      ok: true,
      worktree: worktree({ path: symlinkRoot }),
    };
    await expect(resolver.resolve(owner, ref)).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    await rm(symlinkRoot);
    await rm(managedParent, { recursive: true });
    await mkdir(join(targetPath, "wt_abc123def456"));
    await symlink(targetPath, managedParent);
    response = {
      ok: true,
      worktree: worktree({ path: symlinkRoot }),
    };
    await expect(resolver.resolve(owner, ref)).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    await rm(managedParent);
    await symlink(insideTargetPath, managedParent);
    await expect(resolver.resolve(owner, ref)).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    response = { ok: false, status: 503, error: new Error("secret upstream detail") };
    await expect(resolver.resolve(owner, ref)).rejects.toEqual(
      new ChatExecutionRootError("validation_unavailable"),
    );
    await expect(resolver.revalidate(owner, {
      ref,
      fingerprint: "not-a-fingerprint",
    })).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    expect(() => createChatExecutionRootResolver({
      homePath,
      projects: {
        getProjectById: vi.fn(),
        resolveProjectWorkingDirectory: vi.fn(),
      },
    })).toThrow("Chat execution-root dependencies are unavailable");
  });
});
