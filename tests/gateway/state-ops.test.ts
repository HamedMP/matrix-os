import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  createStateOps,
  ProjectLockCapacityError,
  readJsonFile,
  withProjectLock,
} from "../../packages/gateway/src/state-ops.js";
import {
  readBoundedJsonFileWithIdentity,
  removeFileIfUnchanged,
} from "../../packages/gateway/src/bounded-json-file.js";
import { removeValidatedLegacyProjectState } from "../../packages/gateway/src/legacy-project-state.js";

describe("state-ops", () => {
  let homePath: string;

  function projectRecord(
    slug: string,
    ownerId = "user_a",
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `proj_${slug}`,
      name: slug,
      slug,
      kind: "folder",
      localPath: join(homePath, "projects", slug),
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: ownerId },
      ...overrides,
    };
  }

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-state-ops-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("writes JSON atomically using a same-directory temporary file", async () => {
    const target = join(homePath, "system", "sessions", "sess_1.json");

    await atomicWriteJson(target, { id: "sess_1", ok: true });

    await expect(readJsonFile(target)).resolves.toEqual({ id: "sess_1", ok: true });
    await expect(readdir(join(homePath, "system", "sessions"))).resolves.toEqual(["sess_1.json"]);
  });

  it("does not delete a file that was replaced after bounded validation", async () => {
    const target = join(homePath, "legacy.json");
    const replacement = join(homePath, "replacement.json");
    await writeFile(target, JSON.stringify({ id: "original" }));
    const candidate = await readBoundedJsonFileWithIdentity(target, 1024);
    expect(candidate?.value).toEqual({ id: "original" });
    await writeFile(replacement, JSON.stringify({ id: "replacement" }));
    await rename(replacement, target);

    await expect(removeFileIfUnchanged(target, candidate!.identity, {
      recoveryDir: join(homePath, "system", "recovery", "project-state"),
    })).resolves.toBe(false);
    await expect(readFile(target, "utf-8")).resolves.toContain("replacement");
  });

  it("preserves a replacement published while a validated file is quarantined", async () => {
    const target = join(homePath, "legacy.json");
    await writeFile(target, JSON.stringify({ id: "original" }));
    const candidate = await readBoundedJsonFileWithIdentity(target, 1024);
    expect(candidate?.value).toEqual({ id: "original" });

    await expect(removeFileIfUnchanged(target, candidate!.identity, {
      recoveryDir: join(homePath, "system", "recovery", "project-state"),
      onQuarantined: async () => {
        await writeFile(target, JSON.stringify({ id: "replacement" }));
      },
    })).resolves.toBe(true);

    await expect(readFile(target, "utf-8")).resolves.toContain("replacement");
  });

  it("moves a raced quarantine out of the owner workspace without deleting either winner", async () => {
    const target = join(homePath, "legacy.json");
    const replacement = join(homePath, "replacement.json");
    const recoveryDir = join(homePath, "system", "recovery", "project-state");
    await writeFile(target, JSON.stringify({ id: "original" }));
    const candidate = await readBoundedJsonFileWithIdentity(target, 1024);
    await writeFile(replacement, JSON.stringify({ id: "replacement" }));

    await expect(removeFileIfUnchanged(target, candidate!.identity, {
      recoveryDir,
      onValidatedBeforeQuarantine: async () => {
        await rename(replacement, target);
      },
      onRenamed: async () => {
        await writeFile(target, JSON.stringify({ id: "winner" }));
      },
    })).resolves.toBe(false);

    await expect(readFile(target, "utf-8")).resolves.toContain("winner");
    await expect(readdir(homePath)).resolves.not.toEqual(expect.arrayContaining([
      expect.stringContaining(".quarantine"),
    ]));
    const recovered = await readdir(recoveryDir);
    expect(recovered).toHaveLength(1);
    await expect(readFile(join(recoveryDir, recovered[0]!), "utf-8")).resolves.toContain("replacement");
  });

  it("keeps concurrent project-state recovery bounded", async () => {
    const recoveryDir = join(homePath, "system", "recovery", "project-state");
    const candidates = await Promise.all(Array.from({ length: 105 }, async (_, index) => {
      const target = join(homePath, `legacy-${index}.json`);
      const replacement = join(homePath, `replacement-${index}.json`);
      await writeFile(target, JSON.stringify({ id: `original-${index}` }));
      const candidate = await readBoundedJsonFileWithIdentity(target, 1024);
      await writeFile(replacement, JSON.stringify({ id: `replacement-${index}` }));
      return { target, replacement, candidate: candidate! };
    }));

    await Promise.all(candidates.map(({ target, replacement, candidate }, index) => (
      removeFileIfUnchanged(target, candidate.identity, {
        recoveryDir,
        onValidatedBeforeQuarantine: async () => rename(replacement, target),
        onRenamed: async () => writeFile(target, JSON.stringify({ id: `winner-${index}` })),
      })
    )));

    await expect(readdir(recoveryDir)).resolves.toHaveLength(100);
  });

  it("does not delete a legacy task replaced after record validation", async () => {
    const tasksDir = join(homePath, "projects", "repo", "tasks");
    const previewsDir = join(homePath, "projects", "repo", "previews");
    const taskPath = join(tasksDir, "task_owned123.json");
    const replacementPath = join(homePath, "replacement-task.json");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(previewsDir, { recursive: true });
    await atomicWriteJson(taskPath, {
      id: "task_owned123",
      projectSlug: "repo",
      title: "Owned task",
      status: "todo",
      priority: "normal",
      order: 1,
      previewIds: [],
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    });
    await writeFile(replacementPath, JSON.stringify({ id: "owner-replacement" }));

    await removeValidatedLegacyProjectState({
      projectSlug: "repo",
      tasksDir,
      previewsDir,
      recoveryDir: join(homePath, "system", "recovery", "project-state"),
      onCandidateValidated: async () => {
        await rename(replacementPath, taskPath);
      },
    });

    await expect(readFile(taskPath, "utf-8")).resolves.toContain("owner-replacement");
  });

  it("replays clone staging operation logs by deleting abandoned staging directories", async () => {
    const staged = join(homePath, "system", "clone-staging", "repo-abc");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "partial"), "partial clone");
    const ops = createStateOps({ homePath, now: () => "2026-04-26T00:00:00.000Z" });
    await ops.recordOperation({
      id: "op_1",
      type: "clone_project",
      status: "staged",
      projectSlug: "repo",
      stagingPath: staged,
    });

    const result = await ops.recoverOperations();

    expect(result.cleanedStaging).toEqual([staged]);
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an active same-project lock mutually exclusive at the lock capacity", async () => {
    const releases: Array<() => void> = [];
    const entered = new Set<string>();
    const holders = Array.from({ length: 256 }, (_, index) => {
      const slug = `capacity-${index}`;
      return withProjectLock(slug, async () => {
        entered.add(slug);
        await new Promise<void>((resolve) => releases.push(resolve));
      });
    });
    await vi.waitFor(() => expect(entered.size).toBe(256));

    await expect(withProjectLock("capacity-overflow", async () => undefined))
      .rejects.toBeInstanceOf(ProjectLockCapacityError);

    let duplicateEntered = false;
    const duplicate = withProjectLock("capacity-0", async () => {
      duplicateEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(duplicateEntered).toBe(false);

    for (const release of releases) release();
    await Promise.all([...holders, duplicate]);
    expect(duplicateEntered).toBe(true);
  });

  it("exports and deletes only the requested owner-scoped project data", async () => {
    await mkdir(join(homePath, "projects", "keep"), { recursive: true });
    await mkdir(join(homePath, "projects", "drop"), { recursive: true });
    await atomicWriteJson(
      join(homePath, "system", "projects", "keep", "config.json"),
      projectRecord("keep"),
    );
    await atomicWriteJson(
      join(homePath, "system", "projects", "drop", "config.json"),
      projectRecord("drop"),
    );
    await atomicWriteJson(join(homePath, "system", "projects", "drop", "tasks", "task_abc123.json"), {
      id: "task_abc123",
      title: "Exported task",
    });
    await atomicWriteJson(join(homePath, "system", "projects", "drop", "previews", "prev_abc123.json"), {
      id: "prev_abc123",
      url: "http://localhost:3000",
    });
    await writeFile(join(homePath, "projects", "drop", "README.md"), "owner workspace");
    const outside = await mkdtemp(join(tmpdir(), "matrix-state-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(homePath, "projects", "drop", "outside-link"));
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({ scope: "project", projectSlug: "drop", ownerScope: { type: "user", id: "user_a" } });
    expect(manifest.files).toContain("system/projects/drop/config.json");
    expect(manifest.files).toContain("system/projects/drop/tasks/task_abc123.json");
    expect(manifest.files).toContain("system/projects/drop/previews/prev_abc123.json");
    expect(manifest.files).toContain("projects/drop/README.md");
    expect(manifest.files).not.toContain("projects/drop/outside-link/secret.txt");
    expect(manifest.files).not.toContain("system/projects/keep/config.json");

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "drop",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(homePath, "projects", "drop", "README.md"), "utf-8")).resolves.toBe("owner workspace");
    await expect(stat(join(homePath, "system", "projects", "drop"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(homePath, "system", "projects", "keep", "config.json"), "utf-8")).resolves.toContain("keep");
  });

  it("rejects invalid project slugs before deleting workspace data", async () => {
    await atomicWriteJson(join(homePath, "system", "projects", "keep", "config.json"), {
      slug: "keep",
      ownerScope: { type: "user", id: "user_a" },
    });
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "",
      confirmation: "delete project workspace data",
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "delete_scope_invalid" },
    });
    await expect(readFile(join(homePath, "system", "projects", "keep", "config.json"), "utf-8")).resolves.toContain("keep");
  });

  it("preserves owner source when deleting a legacy folder record without kind", async () => {
    const source = join(homePath, "projects", "legacy-folder");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "owner source");
    await atomicWriteJson(join(homePath, "system", "projects", "legacy-folder", "config.json"), {
      id: "proj_legacy_folder",
      name: "Legacy folder",
      slug: "legacy-folder",
      localPath: source,
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    });
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "legacy-folder",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toEqual({ ok: true });

    await expect(readFile(join(source, "README.md"), "utf-8")).resolves.toBe("owner source");
    await expect(stat(join(homePath, "system", "projects", "legacy-folder")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes validated legacy Matrix state while preserving arbitrary owner files", async () => {
    const source = join(homePath, "projects", "legacy-state-delete");
    const tasksDir = join(source, "tasks");
    const previewsDir = join(source, "previews");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(previewsDir, { recursive: true });
    await writeFile(join(tasksDir, "README.md"), "owner notes");
    await atomicWriteJson(join(tasksDir, "task_unknown123.json"), {
      id: "task_unknown123",
      projectSlug: "legacy-state-delete",
      title: "missing required Matrix fields",
    });
    await atomicWriteJson(join(tasksDir, "task_other123.json"), {
      id: "task_other123",
      projectSlug: "another-project",
      title: "Other project",
      status: "todo",
      priority: "normal",
      order: 0,
      previewIds: [],
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    const taskPath = join(tasksDir, "task_owned123.json");
    await atomicWriteJson(taskPath, {
      id: "task_owned123",
      projectSlug: "legacy-state-delete",
      title: "Owned task",
      status: "todo",
      priority: "normal",
      order: 0,
      previewIds: [],
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    const previewPath = join(previewsDir, "prev_owned123.json");
    await atomicWriteJson(previewPath, {
      id: "prev_owned123",
      projectSlug: "legacy-state-delete",
      label: "Owned preview",
      url: "http://localhost:3000",
      lastStatus: "unknown",
      displayPreference: "panel",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    await atomicWriteJson(
      join(homePath, "system", "projects", "legacy-state-delete", "config.json"),
      projectRecord("legacy-state-delete"),
    );
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "legacy-state-delete",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toEqual({ ok: true });

    await expect(stat(taskPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(previewPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(tasksDir, "README.md"), "utf-8")).resolves.toBe("owner notes");
    await expect(stat(join(tasksDir, "task_unknown123.json"))).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(stat(join(tasksDir, "task_other123.json"))).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("refuses to delete owner source from an invalid project registry record", async () => {
    const source = join(homePath, "projects", "malformed");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "owner source");
    await atomicWriteJson(join(homePath, "system", "projects", "malformed", "config.json"), {
      id: "proj_malformed",
      name: "Malformed",
      slug: "different-slug",
      kind: "github",
      localPath: source,
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    });
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "malformed",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "not_found" },
    });
    await expect(readFile(join(source, "README.md"), "utf-8")).resolves.toBe("owner source");
  });

  it("preserves a same-slug owner folder when managed kind and local path disagree", async () => {
    const ownerFolder = join(homePath, "projects", "mismatched");
    const recordedSource = join(homePath, "projects", "elsewhere", "repo");
    await mkdir(ownerFolder, { recursive: true });
    await mkdir(recordedSource, { recursive: true });
    await writeFile(join(ownerFolder, "keep.txt"), "owner source");
    await atomicWriteJson(
      join(homePath, "system", "projects", "mismatched", "config.json"),
      projectRecord("mismatched", "user_a", {
        kind: "github",
        localPath: recordedSource,
      }),
    );
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "mismatched",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toEqual({ ok: true });

    await expect(readFile(join(ownerFolder, "keep.txt"), "utf-8")).resolves.toBe("owner source");
    await expect(stat(join(homePath, "system", "projects", "mismatched")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the owner-scoped project tombstone with its registry config", async () => {
    const record = projectRecord("delete-with-tombstone");
    await atomicWriteJson(
      join(homePath, "system", "projects", "delete-with-tombstone", "config.json"),
      record,
    );
    const tombstonePath = join(
      homePath,
      "system",
      "projects",
      ".deleting",
      "delete-with-tombstone.json",
    );
    await atomicWriteJson(tombstonePath, { ...record, deletingAt: "2026-04-27T00:00:00.000Z" });
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "delete-with-tombstone",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toEqual({ ok: true });

    await expect(stat(tombstonePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an owner-scoped tombstone when the project config is already gone", async () => {
    const tombstonePath = join(homePath, "system", "projects", ".deleting", "tombstone-delete.json");
    await atomicWriteJson(tombstonePath, {
      ...projectRecord("tombstone-delete"),
      deletingAt: "2026-04-27T00:00:00.000Z",
    });
    const ops = createStateOps({ homePath });

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "tombstone-delete",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toEqual({ ok: true });

    await expect(stat(tombstonePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports all owner-scoped workspace data for full backups", async () => {
    await atomicWriteJson(join(homePath, "system", "sessions", "sess_abc123.json"), {
      id: "sess_abc123",
      status: "running",
    });
    await atomicWriteJson(
      join(homePath, "system", "projects", "owned", "config.json"),
      projectRecord("owned"),
    );
    await atomicWriteJson(join(homePath, "system", "projects", "owned", "tasks", "task_abc123.json"), {
      id: "task_abc123",
    });
    await atomicWriteJson(
      join(homePath, "system", "projects", "other", "config.json"),
      projectRecord("other", "user_b"),
    );
    await atomicWriteJson(join(homePath, "system", "projects", "other", "tasks", "task_def456.json"), {
      id: "task_def456",
    });
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({ scope: "all", ownerScope: { type: "user", id: "user_a" } });

    expect(manifest.files).toContain("system/sessions/sess_abc123.json");
    expect(manifest.files).toContain("system/projects/owned/config.json");
    expect(manifest.files).toContain("system/projects/owned/tasks/task_abc123.json");
    expect(manifest.files).not.toContain("system/projects/other/config.json");
    expect(manifest.files).not.toContain("system/projects/other/tasks/task_def456.json");
  });

  it("exports an owner workspace outside the projects registry path", async () => {
    const workspacePath = join(homePath, "workspaces", "external-checkout");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "README.md"), "external owner workspace");
    await atomicWriteJson(
      join(homePath, "system", "projects", "external", "config.json"),
      projectRecord("external", "user_a", { localPath: workspacePath }),
    );
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({
      scope: "project",
      projectSlug: "external",
      ownerScope: { type: "user", id: "user_a" },
    });

    expect(manifest.files).toContain("system/projects/external/config.json");
    expect(manifest.files).toContain("workspaces/external-checkout/README.md");
  });

  it("exports legacy Matrix task, preview, and tombstone state before lazy adoption", async () => {
    const projectRoot = join(homePath, "projects", "legacy-state");
    const config = {
      id: "proj_legacy_state",
      name: "Legacy state",
      slug: "legacy-state",
      kind: "scratch",
      localPath: join(projectRoot, "repo"),
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    };
    await atomicWriteJson(join(homePath, "system", "projects", "legacy-state", "config.json"), config);
    await atomicWriteJson(join(projectRoot, "tasks", "task_legacy123.json"), {
      id: "task_legacy123",
      projectSlug: "legacy-state",
      title: "Legacy task",
      status: "todo",
      priority: "normal",
      order: 0,
      previewIds: [],
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    });
    await atomicWriteJson(join(projectRoot, "previews", "prev_legacy123.json"), {
      id: "prev_legacy123",
      projectSlug: "legacy-state",
      label: "Legacy preview",
      url: "http://localhost:3000",
      lastStatus: "unknown",
      displayPreference: "panel",
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    });
    await atomicWriteJson(join(homePath, "projects", ".deleting", "legacy-state.json"), {
      ...config,
      deletingAt: "2026-04-27T00:00:00.000Z",
    });
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({
      scope: "project",
      projectSlug: "legacy-state",
      ownerScope: { type: "user", id: "user_a" },
    });

    expect(manifest.files).toContain("projects/legacy-state/tasks/task_legacy123.json");
    expect(manifest.files).toContain("projects/legacy-state/previews/prev_legacy123.json");
    expect(manifest.files).toContain("system/projects/.deleting/legacy-state.json");
  });

  it("exports validated legacy Matrix state for a folder project with an external workspace", async () => {
    const workspace = join(homePath, "workspaces", "external-folder");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "README.md"), "owner workspace");
    await atomicWriteJson(
      join(homePath, "system", "projects", "external-folder", "config.json"),
      projectRecord("external-folder", "user_a", { kind: "folder", localPath: workspace }),
    );
    await atomicWriteJson(
      join(homePath, "projects", "external-folder", "tasks", "task_external123.json"),
      {
        id: "task_external123",
        projectSlug: "external-folder",
        title: "External task",
        status: "todo",
        priority: "normal",
        order: 0,
        previewIds: [],
        createdAt: "2026-04-26T00:00:00.000Z",
        updatedAt: "2026-04-26T00:00:00.000Z",
      },
    );
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({
      scope: "project",
      projectSlug: "external-folder",
      ownerScope: { type: "user", id: "user_a" },
    });

    expect(manifest.files).toContain("projects/external-folder/tasks/task_external123.json");
    expect(manifest.files).toContain("workspaces/external-folder/README.md");
  });

  it.each([
    ["canonical", "system/projects/.deleting/tombstone-only.json"],
    ["legacy", "projects/.deleting/tombstone-only.json"],
  ])("exports a %s deletion tombstone even when the project config is gone", async (_source, tombstoneFile) => {
    const source = join(homePath, "projects", "tombstone-only");
    const tombstone = {
      id: "proj_tombstone_only",
      name: "Tombstone only",
      slug: "tombstone-only",
      kind: "folder",
      localPath: source,
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      deletingAt: "2026-04-27T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    };
    await atomicWriteJson(join(homePath, tombstoneFile), tombstone);
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({
      scope: "project",
      projectSlug: "tombstone-only",
      ownerScope: { type: "user", id: "user_a" },
    });

    expect(manifest.files).toContain("system/projects/.deleting/tombstone-only.json");
  });
});
