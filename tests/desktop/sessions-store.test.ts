import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useSessions } from "@desktop/renderer/src/stores/sessions";

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    getText: vi.fn().mockResolvedValue(""),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

beforeEach(() => {
  useSessions.setState({ sessions: [], aliasMap: {}, loading: false, creating: false, error: null });
});

describe("useSessions.create", () => {
  it("POSTs the session, reloads, and resolves the new attach name", async () => {
    const post = vi.fn().mockResolvedValue({ session: { id: "sess_new" } });
    // After creation, the reload returns the workspace session carrying its
    // zellij attach name so the merged aliasMap can resolve it.
    const get = vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") return { sessions: [{ name: "matrix-task-9", status: "active" }] };
      return { sessions: [{ id: "sess_new", runtime: { zellijSession: "matrix-task-9" } }], nextCursor: null };
    });
    const api = makeApi({ post, get });

    const created = await useSessions.getState().create(api, {
      kind: "agent",
      agent: "claude",
      projectSlug: "proj",
      taskId: "task_a",
      prompt: "Fix the failing auth tests",
    });

    expect(post).toHaveBeenCalledWith("/api/sessions", {
      kind: "agent",
      agent: "claude",
      projectSlug: "proj",
      taskId: "task_a",
      prompt: "Fix the failing auth tests",
    });
    expect(created).toEqual({ sessionId: "sess_new", attachName: "matrix-task-9" });
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBeNull();
  });

  it("returns a null attach name when the new session has no zellij runtime yet", async () => {
    const post = vi.fn().mockResolvedValue({ session: { id: "sess_orch" } });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") return { sessions: [] };
      return { sessions: [{ id: "sess_orch", runtime: {} }], nextCursor: null };
    });
    const api = makeApi({ post, get });
    const created = await useSessions.getState().create(api, { kind: "shell", taskId: "task_a" });
    expect(created).toEqual({ sessionId: "sess_orch", attachName: null });
  });

  it("surfaces an error category and clears the creating flag on failure", async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new AppError("offline")) });
    const created = await useSessions.getState().create(api, { kind: "shell", taskId: "task_a" });
    expect(created).toBeNull();
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBe("offline");
  });
});
