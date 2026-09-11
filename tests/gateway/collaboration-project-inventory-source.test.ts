import { describe, expect, it, vi } from "vitest";
import { createGatewayProjectInventorySource } from "../../packages/gateway/src/collaboration/project-inventory-source.js";

const OWNER = "user_owner";
const PROJECT = "proj_alpha";
const HOME = "/home/matrix/home";
const ROOT = "/home/matrix/home/projects/alpha/repo";

function dependencies() {
  return {
    homePath: HOME,
    projects: {
      get: vi.fn(async (ownerId, projectId) => ownerId === OWNER && projectId === PROJECT
        ? { id: PROJECT, ownerId: OWNER, rootPath: ROOT, updatedAt: "2026-09-11T12:00:00.000Z" }
        : null),
    },
    chats: {
      list: vi.fn(async () => [
        { id: "chat_alpha", revision: 4 },
        { id: "chat_archived", revision: 8 },
      ]),
    },
    canvases: {
      getProjectCanvas: vi.fn(async () => ({
        id: "cnv_project_alpha",
        revision: 6,
        nodes: [
          { type: "app_window", sourceRef: { kind: "app_window", id: "app_board", projectId: PROJECT } },
          { type: "app_window", sourceRef: { kind: "app_window", id: "app_personal" } },
          { type: "terminal", sourceRef: { kind: "terminal_session", id: "terminal-owned", projectId: PROJECT } },
          { type: "terminal", sourceRef: { kind: "terminal_session", id: "terminal-unsafe", projectId: PROJECT } },
          { type: "terminal", sourceRef: { kind: "terminal_session", id: "terminal-personal" } },
        ],
      })),
    },
    apps: {
      get: vi.fn(async (appId) => appId === "app_board" ? { id: appId, collaborationMode: "scoped" as const } : null),
    },
    sessions: {
      list: vi.fn(async () => [
        {
          name: "terminal-owned",
          canonicalName: "terminal-owned",
          cwd: "projects/alpha/repo",
          updatedAt: "2026-09-11T12:01:00.000Z",
          sessionIncarnation: "terminal-11111111111111111111111111111111",
          incarnationVerified: true,
          sharedControlMode: "eligible" as const,
        },
        {
          name: "terminal-unsafe",
          canonicalName: "terminal-unsafe",
          cwd: "projects/alpha/repo",
          updatedAt: "2026-09-11T12:02:00.000Z",
          incarnationVerified: false,
        },
        {
          name: "terminal-personal",
          canonicalName: "terminal-personal",
          cwd: "projects/private",
          updatedAt: "2026-09-11T12:03:00.000Z",
          sessionIncarnation: "terminal-22222222222222222222222222222222",
          incarnationVerified: true,
          sharedControlMode: "eligible" as const,
        },
      ]),
    },
  };
}

function fixture() {
  return createGatewayProjectInventorySource(dependencies());
}

describe("gateway project inventory source", () => {
  it("projects owner-bound canonical state and keeps linked personal resources external", async () => {
    const source = fixture();

    await expect(source.getProject(OWNER, PROJECT)).resolves.toMatchObject({
      id: PROJECT,
      ownerId: OWNER,
      rootPath: ROOT,
      revision: Date.parse("2026-09-11T12:00:00.000Z"),
    });
    await expect(source.listChats(OWNER, PROJECT)).resolves.toEqual([
      { id: "chat_alpha", revision: "4", compatibility: "ready" },
      { id: "chat_archived", revision: "8", compatibility: "ready" },
    ]);
    await expect(source.getLayout(OWNER, PROJECT)).resolves.toEqual({
      id: "cnv_project_alpha",
      revision: "6",
      compatibility: "ready",
    });
    await expect(source.listApps(OWNER, PROJECT)).resolves.toEqual([
      { id: "app_board", revision: "6", compatibility: "ready" },
      { id: "app_personal", revision: "6", ownership: "external" },
    ]);
    await expect(source.listTerminals(OWNER, PROJECT)).resolves.toEqual([
      {
        id: "terminal-owned",
        revision: String(Date.parse("2026-09-11T12:01:00.000Z")),
        compatibility: "ready",
        incarnation: "terminal-11111111111111111111111111111111",
      },
      {
        id: "terminal-personal",
        revision: String(Date.parse("2026-09-11T12:03:00.000Z")),
        ownership: "external",
      },
      {
        id: "terminal-unsafe",
        revision: String(Date.parse("2026-09-11T12:02:00.000Z")),
        compatibility: "blocked",
        blocker: "terminal_incarnation_unavailable",
      },
    ]);
  });

  it("fails closed on owner mismatch and malformed project revision", async () => {
    const source = fixture();
    await expect(source.getProject("user_other", PROJECT)).resolves.toBeNull();

    const badRevision = createGatewayProjectInventorySource({
      ...dependencies(),
      projects: { get: async () => ({ id: PROJECT, ownerId: OWNER, rootPath: ROOT, updatedAt: "bad" }) },
    });
    await expect(badRevision.getProject(OWNER, PROJECT)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("includes current workspace terminal refs and fails closed without an incarnation proof", async () => {
    const workspaceId = "tws_0123456789abcdef0123456789abcdef";
    const projectTabId = "tt_0123456789abcdef0123456789abcdef";
    const personalTabId = "tt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const current = dependencies();
    current.canvases.getProjectCanvas = vi.fn(async () => ({
      id: "cnv_project_alpha",
      revision: 7,
      nodes: [
        {
          type: "terminal",
          sourceRef: { kind: "terminal_tab", terminalRef: { workspaceId, tabId: projectTabId } },
        },
        {
          type: "terminal",
          sourceRef: {
            kind: "terminal_tab",
            terminalRef: {
              workspaceId: "tws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              tabId: personalTabId,
            },
          },
        },
      ],
    }));
    current.sessions.list = vi.fn(async () => [
      {
        id: workspaceId,
        scope: "project",
        projectId: PROJECT,
        canonicalSize: { cols: 120, rows: 36 },
        status: "running",
        revision: 2,
        createdAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:02:00.000Z",
        tabs: [{
          id: projectTabId,
          workspaceId,
          name: "project",
          cwd: "projects/alpha/repo",
          status: "running",
          revision: 1,
          order: 0,
          createdAt: "2026-09-11T12:01:00.000Z",
          updatedAt: "2026-09-11T12:02:00.000Z",
        }],
      },
      {
        id: "tws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        scope: "main",
        canonicalSize: { cols: 120, rows: 36 },
        status: "running",
        revision: 1,
        createdAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:03:00.000Z",
        tabs: [{
          id: personalTabId,
          workspaceId: "tws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          name: "personal",
          cwd: "projects/private",
          status: "running",
          revision: 1,
          order: 0,
          createdAt: "2026-09-11T12:01:00.000Z",
          updatedAt: "2026-09-11T12:03:00.000Z",
        }],
      },
    ]);
    const source = createGatewayProjectInventorySource(current);

    await expect(source.listTerminals(OWNER, PROJECT)).resolves.toEqual([
      {
        id: `${workspaceId}:${projectTabId}`,
        revision: String(Date.parse("2026-09-11T12:02:00.000Z")),
        compatibility: "blocked",
        blocker: "terminal_incarnation_unavailable",
      },
      {
        id: `tws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${personalTabId}`,
        revision: String(Date.parse("2026-09-11T12:03:00.000Z")),
        ownership: "external",
      },
    ]);
  });
});
