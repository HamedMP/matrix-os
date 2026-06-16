import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { startTaskSession } from "@desktop/renderer/src/lib/task-sessions";
import { useBoard, type Card } from "@desktop/renderer/src/stores/board";
import { useSessions } from "@desktop/renderer/src/stores/sessions";

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") return { sessions: [{ name: "matrix-task-1", status: "active" }] };
      if (path === "/api/sessions") {
        return { sessions: [{ id: "sess_new", runtime: { zellijSession: "matrix-task-1" } }], nextCursor: null };
      }
      return { tasks: [], nextCursor: null };
    }),
    post: vi.fn().mockResolvedValue({ session: { id: "sess_new" } }),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "task_a",
    projectSlug: "proj",
    title: "Task A",
    description: "Fix it",
    status: "todo",
    priority: "normal",
    order: 0,
    parentTaskId: null,
    linkedSessionId: null,
    linkedWorktreeId: null,
    previewIds: [],
    tags: [],
    updatedAt: "2026-06-13T00:00:00.000Z",
    revision: null,
    ...overrides,
  };
}

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useSessions.setState(useSessions.getInitialState(), true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startTaskSession", () => {
  it("returns false when task linking fails after creating the session", async () => {
    const api = makeApi({
      patch: vi.fn().mockRejectedValue(new AppError("server")),
    });
    useBoard.setState({ cardsByProject: { proj: [card()] } });

    const ok = await startTaskSession(api, {
      projectSlug: "proj",
      taskId: "task_a",
      worktreeId: null,
      title: "Task A",
      description: "Fix it",
      kind: "agent",
      agent: "claude",
    });

    expect(ok).toBe(false);
    expect(api.post).toHaveBeenCalledWith("/api/sessions", {
      kind: "agent",
      agent: "claude",
      projectSlug: "proj",
      taskId: "task_a",
      prompt: "Task A\n\nFix it",
    });
    expect(useBoard.getState().error).toBe("server");
    expect(useBoard.getState().cardsByProject.proj?.some((task) => task.linkedSessionId === "sess_new")).toBe(false);
  });
});
