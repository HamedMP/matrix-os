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
});
