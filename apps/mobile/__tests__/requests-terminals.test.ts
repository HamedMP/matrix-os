import {
  createTerminalSession,
  deleteTerminalSession,
  fetchTerminalSessions,
  isValidTerminalSessionName,
  renameTerminalSession,
} from "@/lib/requests/terminals";

const GATEWAY_URL = "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1";
const MAIN_WORKSPACE = "tws_00000000000000000000000000000001";
const PROJECT_WORKSPACE = "tws_00000000000000000000000000000002";
const TAB_A = "tt_0000000000000000000000000000000a";
const TAB_B = "tt_0000000000000000000000000000000b";
const TAB_C = "tt_0000000000000000000000000000000c";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function tab(id: string, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId,
    name: "swift-falcon",
    cwd: "projects",
    status: "running",
    revision: 3,
    order: 0,
    accessScope: "owner",
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:05:00.000Z",
    ...overrides,
  };
}

describe("terminal requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("loads every workspace tab from the selected computer route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({
      workspaces: [
        {
          id: MAIN_WORKSPACE,
          scope: "main",
          revision: 9,
          tabs: [
            tab(TAB_A, MAIN_WORKSPACE, {
              agent: { providerId: "claude" },
              git: { branch: "main", dirty: false },
            }),
            tab(TAB_B, MAIN_WORKSPACE, { name: "Shell", status: "exited", revision: 1, cwd: "" }),
          ],
        },
        {
          id: PROJECT_WORKSPACE,
          scope: "project",
          projectId: "matrix-os",
          revision: 2,
          tabs: [tab(TAB_C, PROJECT_WORKSPACE, { name: "review", status: "failed", cwd: "projects/matrix-os" })],
        },
      ],
    }));

    const sessions = await fetchTerminalSessions("clerk-token", GATEWAY_URL);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/terminal/workspaces?runtime=preview-1",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sessions).toEqual([
      {
        id: `${MAIN_WORKSPACE}:${TAB_A}`,
        workspaceId: MAIN_WORKSPACE,
        tabId: TAB_A,
        revision: 3,
        name: "swift-falcon",
        cwd: "projects",
        status: "active",
        visualStatus: "running",
        agent: "claude",
        branch: "main",
      },
      {
        id: `${MAIN_WORKSPACE}:${TAB_B}`,
        workspaceId: MAIN_WORKSPACE,
        tabId: TAB_B,
        revision: 1,
        name: "Shell",
        cwd: "",
        status: "exited",
        visualStatus: "idle",
      },
      {
        id: `${PROJECT_WORKSPACE}:${TAB_C}`,
        workspaceId: PROJECT_WORKSPACE,
        tabId: TAB_C,
        revision: 3,
        name: "review",
        cwd: "projects/matrix-os",
        status: "degraded",
        visualStatus: "waiting",
        projectId: "matrix-os",
      },
    ]);
  });

  it("keeps the list usable when the computer reports fields this build does not know", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({
      workspaces: [
        {
          id: MAIN_WORKSPACE,
          scope: "main",
          futureWorkspaceField: true,
          tabs: [
            tab(TAB_A, MAIN_WORKSPACE, { status: "hibernating", futureTabField: { nested: 1 } }),
            { id: "not-a-tab-id", name: "broken" },
            tab(TAB_B, MAIN_WORKSPACE, { name: "second", agent: { providerId: "gemini" } }),
          ],
        },
        { id: "not-a-workspace-id", tabs: [tab(TAB_C, MAIN_WORKSPACE)] },
      ],
    }));

    const sessions = await fetchTerminalSessions("clerk-token", GATEWAY_URL);

    expect(sessions.map((session) => [session.name, session.status, session.agent])).toEqual([
      ["swift-falcon", "active", undefined],
      ["second", "active", undefined],
    ]);
  });

  it("leaves out terminals that only open from their chat", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({
      workspaces: [{
        id: MAIN_WORKSPACE,
        scope: "main",
        tabs: [
          tab(TAB_A, MAIN_WORKSPACE, { name: "chat-run", accessScope: "chat" }),
          tab(TAB_B, MAIN_WORKSPACE, { name: "migrated", accessScope: "legacy" }),
        ],
      }],
    }));

    const sessions = await fetchTerminalSessions("clerk-token", GATEWAY_URL);

    expect(sessions.map((session) => session.name)).toEqual(["migrated"]);
  });

  it("reports the list as unavailable when the computer rejects the request", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "client_upgrade_required" }, 426));

    await expect(fetchTerminalSessions("clerk-token", GATEWAY_URL))
      .rejects.toThrow("Terminals unavailable. Try again.");
  });

  it("reports the list as unavailable when the response is not a workspace list", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ sessions: [] }));

    await expect(fetchTerminalSessions("clerk-token", GATEWAY_URL))
      .rejects.toThrow("Terminals unavailable. Try again.");
  });

  it("creates a tab in the main workspace with the desktop default working directory", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ workspace: { id: MAIN_WORKSPACE, scope: "main", tabs: [] } }))
      .mockResolvedValueOnce(jsonResponse({ tab: tab(TAB_A, MAIN_WORKSPACE) }, 201));

    await expect(createTerminalSession("clerk-token", GATEWAY_URL, "swift-falcon"))
      .resolves.toBe(`${MAIN_WORKSPACE}:${TAB_A}`);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://app.matrix-os.com/vm/solar-vale/api/terminal/workspaces/ensure?runtime=preview-1",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://app.matrix-os.com/vm/solar-vale/api/terminal/workspaces/${MAIN_WORKSPACE}/tabs?runtime=preview-1`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "swift-falcon", cwd: "projects" }),
      }),
    );
  });

  it("does not create a tab when the workspace could not be prepared", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ workspace: { id: "tws_bad" } }));

    await expect(createTerminalSession("clerk-token", GATEWAY_URL, "swift-falcon"))
      .rejects.toThrow("Could not create terminal. Try again.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renames a tab against the revision the list last showed", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({
      tab: tab(TAB_A, MAIN_WORKSPACE, { name: "Deploy logs", revision: 4 }),
    }));

    await expect(renameTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: MAIN_WORKSPACE, tabId: TAB_A, revision: 3 },
      "Deploy logs",
    )).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/vm/solar-vale/api/terminal/workspaces/${MAIN_WORKSPACE}/tabs/${TAB_A}?runtime=preview-1`,
      expect.objectContaining({
        method: "PATCH",
        headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Deploy logs", baseRevision: 3 }),
      }),
    );
  });

  it("fails a rename the computer refuses as out of date", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "terminal_revision_conflict" }, 409));

    await expect(renameTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: MAIN_WORKSPACE, tabId: TAB_A, revision: 3 },
      "Deploy logs",
    )).rejects.toThrow("Could not rename terminal. Try again.");
  });

  it("never sends a rename or delete for a malformed terminal reference", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(renameTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: "../etc", tabId: TAB_A, revision: 3 },
      "Deploy logs",
    )).rejects.toThrow("Could not rename terminal. Try again.");
    await expect(deleteTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: MAIN_WORKSPACE, tabId: "tt_bad/../x" },
    )).rejects.toThrow("Could not delete terminal. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a tab and accepts the empty response", async () => {
    const json = jest.fn().mockRejectedValue(new SyntaxError("Unexpected end of input"));
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 204,
      json,
    } as unknown as Response);

    await expect(deleteTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: MAIN_WORKSPACE, tabId: TAB_A },
    )).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/vm/solar-vale/api/terminal/workspaces/${MAIN_WORKSPACE}/tabs/${TAB_A}?runtime=preview-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("treats a tab that is already gone as deleted", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Terminal operation failed" }, 404));

    await expect(deleteTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: MAIN_WORKSPACE, tabId: TAB_A },
    )).resolves.toBeUndefined();
  });

  it("fails a delete the computer could not carry out", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Terminal operation unavailable" }, 503));

    await expect(deleteTerminalSession(
      "clerk-token",
      GATEWAY_URL,
      { workspaceId: MAIN_WORKSPACE, tabId: TAB_A },
    )).rejects.toThrow("Could not delete terminal. Try again.");
  });

  it("accepts the tab names the computer accepts", () => {
    expect(isValidTerminalSessionName("Deploy logs")).toBe(true);
    expect(isValidTerminalSessionName("swift-falcon")).toBe(true);
    expect(isValidTerminalSessionName("x".repeat(120))).toBe(true);
    expect(isValidTerminalSessionName("")).toBe(false);
    expect(isValidTerminalSessionName("   ")).toBe(false);
    expect(isValidTerminalSessionName("x".repeat(121))).toBe(false);
    expect(isValidTerminalSessionName("logs in /tmp/build")).toBe(false);
  });
});
