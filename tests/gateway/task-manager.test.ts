import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskManager } from "../../packages/gateway/src/task-manager.js";

describe("task-manager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-task-manager-"));
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
    await expect(stat(join(homePath, "projects", "repo", "tasks", `${first.task.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates project and task identifiers before filesystem access", async () => {
    const manager = createTaskManager({ homePath });

    await expect(manager.createTask("../bad", { title: "Nope" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_project_slug" },
    });
    await expect(manager.updateTask("repo", "../task", { title: "Nope" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_task_id" },
    });
    await expect(stat(join(homePath, "projects"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports task records as project-owned files", async () => {
    const manager = createTaskManager({ homePath });
    const created = await manager.createTask("repo", { title: "Export me" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(readFile(join(homePath, "projects", "repo", "tasks", `${created.task.id}.json`), "utf-8")).resolves.toContain("Export me");
  });
});
