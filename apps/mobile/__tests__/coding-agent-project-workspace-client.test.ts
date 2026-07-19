import { GatewayClient } from "../lib/gateway-client";
import { jsonResponse } from "./mobile-shell-test-utils";

function projectWorkspacePayload() {
  const threadBase = {
    providerId: "codex",
    status: "running",
    attention: "none",
    projectId: "matrix-os",
    createdAt: "2026-07-10T13:00:00.000Z",
    updatedAt: "2026-07-10T13:30:00.000Z",
  };
  return {
    project: {
      id: "matrix-os",
      label: "Matrix OS",
      status: "available",
      taskCount: 1,
      threadCount: 3,
      attentionCount: 1,
    },
    tasks: {
      items: [{
        id: "task_auth",
        projectId: "matrix-os",
        title: "Repair authentication",
        status: "running",
        priority: "high",
        order: 0,
        threadCount: 2,
        activeThreadCount: 1,
        attentionCount: 1,
      }],
      hasMore: false,
      limit: 100,
    },
    projectThreads: {
      items: [{ ...threadBase, id: "thread_audit", title: "Project audit" }],
      hasMore: false,
      limit: 100,
    },
    taskThreads: {
      items: [
        { ...threadBase, id: "thread_plan", taskId: "task_auth", title: "Plan repair" },
        { ...threadBase, id: "thread_fix", taskId: "task_auth", title: "Implement repair" },
      ],
      hasMore: false,
      limit: 100,
    },
    updatedAt: "2026-07-10T13:30:00.000Z",
  };
}

describe("GatewayClient project coding workspace", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("fetches and validates the bounded project task and conversation projection", async () => {
    const payload = projectWorkspacePayload();
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(payload));
    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");

    await expect(client.getCodingAgentProjectWorkspace({ projectId: "matrix-os" })).resolves.toEqual({
      ok: true,
      workspace: payload,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/coding-agents/projects/matrix-os/workspace",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer clerk-token" }),
        signal: expect.any(Object),
      }),
    );
  });

  it("rejects an unsafe project reference before making a request", async () => {
    const fetchMock = jest.spyOn(global, "fetch");
    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");

    await expect(client.getCodingAgentProjectWorkspace({ projectId: "../private" })).resolves.toEqual({
      ok: false,
      error: "Project workspace unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic recovery error for an invalid gateway payload", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({
      ...projectWorkspacePayload(),
      taskThreads: {
        items: [{
          id: "thread_private",
          providerId: "codex",
          title: "Invalid cross-project relation",
          status: "running",
          projectId: "website",
          taskId: "task_auth",
          createdAt: "2026-07-10T13:00:00.000Z",
          updatedAt: "2026-07-10T13:30:00.000Z",
        }],
        hasMore: false,
        limit: 100,
      },
      providerCredentials: "must not cross the boundary",
    }));
    const client = new GatewayClient("https://app.matrix-os.com", "clerk-token");

    await expect(client.getCodingAgentProjectWorkspace({ projectId: "matrix-os" })).resolves.toEqual({
      ok: false,
      error: "Project workspace unavailable",
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("must not cross the boundary");
  });
});
