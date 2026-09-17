import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { client, resolveCliProfileMock, requireCliAuthTokenMock } = vi.hoisted(() => ({
  client: {
    listProjects: vi.fn(),
    listWorkspaces: vi.fn(),
    ensureWorkspace: vi.fn(),
    createTab: vi.fn(),
    attachTab: vi.fn(),
  },
  resolveCliProfileMock: vi.fn(),
  requireCliAuthTokenMock: vi.fn(),
}));

vi.mock("../../src/cli/profiles.js", () => ({
  resolveCliProfile: resolveCliProfileMock,
}));

vi.mock("../../src/cli/auth-state.js", () => ({
  requireCliAuthToken: requireCliAuthTokenMock,
}));

vi.mock("../../src/cli/shell-client.js", () => ({
  createShellClient: () => client,
}));

const workspaceId = `tws_${"a".repeat(32)}`;
const tabId = `tt_${"b".repeat(32)}`;

beforeEach(() => {
  process.exitCode = undefined;
  vi.resetModules();
  vi.clearAllMocks();
  resolveCliProfileMock.mockResolvedValue({
    name: "cloud",
    gatewayUrl: "https://app.matrix-os.com",
  });
  requireCliAuthTokenMock.mockResolvedValue("token");
  client.listProjects.mockResolvedValue([]);
  client.listWorkspaces.mockResolvedValue([{
    id: workspaceId,
    scope: "main",
    tabs: [],
  }]);
  client.createTab.mockResolvedValue({
    tab: {
      id: tabId,
      name: "codex-handoff",
      cwd: "projects/demo-handoff",
    },
  });
  client.attachTab.mockResolvedValue({ detached: true, exitCode: null });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("matrix shell new", () => {
  it("creates a project-scoped terminal with a bounded startup command", async () => {
    const { shellCommand } = await import("../../src/cli/commands/shell.js");
    const command = shellCommand.subCommands?.new;
    await command?.run?.({
      args: {
        name: "codex-handoff",
        project: "main",
        cwd: "projects/demo-handoff",
        cmd: "codex 'Continue from the handoff'",
        attach: false,
        json: true,
      },
      rawArgs: [],
    } as never);

    expect(client.createTab).toHaveBeenCalledWith(workspaceId, {
      name: "codex-handoff",
      cwd: "projects/demo-handoff",
      command: ["sh", "-lc", "codex 'Continue from the handoff'"],
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(tabId));
  });

  it("rejects an oversized startup command before calling the gateway", async () => {
    const { shellCommand } = await import("../../src/cli/commands/shell.js");
    const command = shellCommand.subCommands?.new;
    await command?.run?.({
      args: {
        name: "codex-handoff",
        project: "main",
        cwd: "projects/demo-handoff",
        cmd: "x".repeat(4097),
        attach: false,
        json: true,
      },
      rawArgs: [],
    } as never);

    expect(client.createTab).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
