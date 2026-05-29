import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient } from "../../src/cli/tui/workspace.js";

describe("TUI workspace client", () => {
  it("routes review/task/preview/event/export/delete operations through gateway paths", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const gateway = { requestJson: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (path === "/api/reviews") return { reviews: [{ id: "rev_1", status: "running" }] };
      if (path === "/api/projects/repo/tasks") return { tasks: [{ id: "task_1", title: "Fix auth" }] };
      if (path === "/api/projects/repo/previews?taskId=task_1") return { previews: [{ id: "prev_1", url: "http://localhost:3000" }] };
      if (path === "/api/workspace/events?projectSlug=repo") return { events: [{ id: "evt_1", type: "task.created" }] };
      return { ok: true, review: { id: "rev_1" }, task: { id: "task_1" }, preview: { id: "prev_1" }, export: { files: [] } };
    }) };
    const client = createWorkspaceClient(gateway);

    await client.listReviews();
    await client.nextReview("rev_1");
    await client.listTasks("repo");
    await client.createTask("repo", { title: "Fix auth", priority: "high" });
    await client.updateTask("repo", "task_1", { status: "running" });
    await client.deleteTask("repo", "task_1");
    await client.listPreviews("repo", { taskId: "task_1" });
    await client.createPreview("repo", { taskId: "task_1", label: "Local", url: "http://localhost:3000" });
    await client.listEvents({ projectSlug: "repo" });
    await client.exportWorkspace({ projectSlug: "repo" });
    await client.deleteWorkspaceData({ projectSlug: "repo", confirmation: "delete project workspace data" });

    expect(calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`)).toEqual([
      "GET /api/reviews",
      "POST /api/reviews/rev_1/next",
      "GET /api/projects/repo/tasks",
      "POST /api/projects/repo/tasks",
      "PATCH /api/projects/repo/tasks/task_1",
      "DELETE /api/projects/repo/tasks/task_1",
      "GET /api/projects/repo/previews?taskId=task_1",
      "POST /api/projects/repo/previews",
      "GET /api/workspace/events?projectSlug=repo",
      "POST /api/workspace/export",
      "DELETE /api/workspace/data",
    ]);
    const deleteCall = calls.at(-1);
    expect(deleteCall?.[1]).toMatchObject({
      method: "DELETE",
      body: expect.stringContaining("delete project workspace data"),
    });
  });
});
