import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskManager } from "../../packages/gateway/src/task-manager.js";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";

describe("task-manager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-task-manager-"));
    await atomicWriteJson(join(homePath, "system", "projects", "repo", "config.json"), {
      id: "proj_repo",
      slug: "repo",
      name: "repo",
      localPath: join(homePath, "projects", "repo"),
      addedAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_a" },
    });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("creates, orders, links, updates, archives, and deletes project tasks", async () => {
    const manager = createTaskManager({ homePath, now: () => "2026-04-26T00:00:00.000Z" });

    const first = await manager.createTask("repo", {
      title: "Wire task workflow",
      description: "Build project-scoped task records",
      priority: "high",
      linkedSessionId: "sess_abc123",
      linkedWorktreeId: "wt_abc123def456",
    });
    const second = await manager.createTask("repo", {
      title: "Review previews",
      priority: "normal",
      order: -10,
      parentTaskId: first.ok ? first.task.id : undefined,
    });

    expect(first).toMatchObject({
      ok: true,
      status: 201,
      task: {
        projectSlug: "repo",
        title: "Wire task workflow",
        status: "todo",
        priority: "high",
        order: 0,
        linkedSessionId: "sess_abc123",
        linkedWorktreeId: "wt_abc123def456",
      },
    });
    expect(second).toMatchObject({ ok: true, task: { order: -10 } });

    await expect(manager.listTasks("repo", { includeArchived: false })).resolves.toMatchObject({
      ok: true,
      tasks: [
        expect.objectContaining({ title: "Review previews" }),
        expect.objectContaining({ title: "Wire task workflow" }),
      ],
      nextCursor: null,
    });

    if (!first.ok) return;
    await expect(manager.updateTask("repo", first.task.id, {
      status: "running",
      order: 25,
      previewIds: ["prev_abc123"],
    })).resolves.toMatchObject({
      ok: true,
      task: { status: "running", order: 25, previewIds: ["prev_abc123"] },
    });
    await expect(manager.updateTask("repo", first.task.id, { status: "archived" })).resolves.toMatchObject({
      ok: true,
      task: { status: "archived", archivedAt: "2026-04-26T00:00:00.000Z" },
    });
    await expect(manager.listTasks("repo", { includeArchived: false })).resolves.toMatchObject({
      ok: true,
      tasks: [expect.objectContaining({ title: "Review previews" })],
    });
    await expect(manager.deleteTask("repo", first.task.id)).resolves.toMatchObject({ ok: true });
    await expect(stat(join(homePath, "system", "projects", "repo", "tasks", `${first.task.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates project and task identifiers before filesystem access", async () => {
    const manager = createTaskManager({ homePath });

    await expect(manager.createTask("../bad", { title: "Nope" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_project_slug" },
    });
    await expect(manager.createTask("ghost-project", { title: "Nope" })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "not_found" },
    });
    await expect(manager.updateTask("repo", "../task", { title: "Nope" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_task_id" },
    });
    await expect(stat(join(homePath, "projects", "ghost-project"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports task records as project-owned files", async () => {
    const manager = createTaskManager({ homePath });
    const created = await manager.createTask("repo", { title: "Export me" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(readFile(join(homePath, "system", "projects", "repo", "tasks", `${created.task.id}.json`), "utf-8")).resolves.toContain("Export me");
  });

  it("keeps legacy project tasks readable and adopts valid records into the registry", async () => {
    const legacy = {
      id: "task_legacy123",
      projectSlug: "repo",
      title: "Legacy task",
      status: "todo",
      priority: "normal",
      order: 0,
      previewIds: [],
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
    };
    await atomicWriteJson(join(homePath, "projects", "repo", "tasks", `${legacy.id}.json`), legacy);
    const manager = createTaskManager({ homePath });

    await expect(manager.listTasks("repo", { includeArchived: true })).resolves.toMatchObject({
      ok: true,
      tasks: [expect.objectContaining({ id: legacy.id, title: "Legacy task" })],
    });
    await expect(readFile(
      join(homePath, "system", "projects", "repo", "tasks", `${legacy.id}.json`),
      "utf-8",
    )).resolves.toContain("Legacy task");
    await expect(manager.deleteTask("repo", legacy.id)).resolves.toEqual({ ok: true });
    await expect(manager.listTasks("repo", { includeArchived: true })).resolves.toMatchObject({ tasks: [] });
  });

  it("preserves an unvalidated owner file that collides with a canonical task id", async () => {
    const manager = createTaskManager({ homePath });
    const created = await manager.createTask("repo", { title: "Canonical task" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ownerFile = join(homePath, "projects", "repo", "tasks", `${created.task.id}.json`);
    await atomicWriteJson(ownerFile, { ownerNote: "keep me" });

    await expect(manager.deleteTask("repo", created.task.id)).resolves.toEqual({ ok: true });
    await expect(readFile(ownerFile, "utf-8")).resolves.toContain("keep me");
    await expect(stat(
      join(homePath, "system", "projects", "repo", "tasks", `${created.task.id}.json`),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects task mutations from a different owner scope", async () => {
    const manager = createTaskManager({ homePath });

    await expect(manager.createTask(
      "repo",
      { title: "Do not create" },
      { type: "user", id: "user_b" },
    )).resolves.toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
  });

  it("fails safely when task identifier discovery exceeds its memory bound", async () => {
    const directory = join(homePath, "system", "projects", "repo", "tasks");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 513 }, (_, index) => (
      writeFile(join(directory, `task_untrusted_${index}.json`), "{}", "utf-8")
    )));
    const manager = createTaskManager({ homePath });

    await expect(manager.listTasks("repo", { includeArchived: true })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "task_limit_exceeded" },
    });
  });
});
