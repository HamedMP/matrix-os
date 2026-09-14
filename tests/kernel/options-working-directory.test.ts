import { describe, expect, it, vi } from "vitest";
import type { MatrixDB } from "../../packages/kernel/src/db.js";

vi.mock("../../packages/kernel/src/ipc-server.js", () => ({
  createIpcServer: vi.fn(async () => ({ name: "matrix-os-ipc" })),
}));

vi.mock("../../packages/kernel/src/agents.js", () => ({
  getCoreAgents: vi.fn(() => ({})),
  loadCustomAgents: vi.fn(() => ({})),
  loadCustomAgentMcpAllowlists: vi.fn(() => ({})),
}));

vi.mock("../../packages/kernel/src/prompt.js", () => ({
  buildSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../../packages/kernel/src/skills.js", () => ({
  ensureSdkSkillsMirror: vi.fn(),
}));

vi.mock("../../packages/kernel/src/hooks.js", () => ({
  safetyGuardHook: vi.fn(),
  updateStateHook: vi.fn(),
  logActivityHook: vi.fn(),
  createGitSnapshotHook: vi.fn(() => vi.fn()),
  persistSessionHook: vi.fn(),
  onSubagentComplete: vi.fn(),
  notifyShellHook: vi.fn(),
  preCompactHook: vi.fn(),
  createIntegrationApprovalHook: vi.fn(() => vi.fn()),
}));

vi.mock("../../packages/kernel/src/evolution.js", () => ({
  createProtectedFilesHook: vi.fn(() => vi.fn()),
}));

import {
  kernelOptions,
  type KernelConfig,
} from "../../packages/kernel/src/options.js";
import { createIpcServer } from "../../packages/kernel/src/ipc-server.js";

describe("kernel working directory", () => {
  const db = {} as MatrixDB;

  it("uses the validated working directory only as the Agent SDK cwd", async () => {
    const config = {
      db,
      homePath: "/home/matrix/home",
      workingDirectory: "/home/matrix/home/projects/matrix-os/repo",
    } as KernelConfig & { workingDirectory: string };

    const options = await kernelOptions(config);

    expect(options.cwd).toBe(config.workingDirectory);
  });

  it("keeps the owner home as the default Agent SDK cwd", async () => {
    const config: KernelConfig = {
      db,
      homePath: "/home/matrix/home",
    };

    const options = await kernelOptions(config);

    expect(options.cwd).toBe(config.homePath);
  });

  it("registers Desktop tools only when authoritative dependencies are injected", async () => {
    const osViewTools = {
      listPlaceableApps: vi.fn(async () => []),
      addAppToDesktop: vi.fn(async () => ({ status: "added" as const })),
    };
    const withoutTools = await kernelOptions({ db, homePath: "/home/matrix/home" });
    const withTools = await kernelOptions({ db, homePath: "/home/matrix/home", osViewTools });

    expect(withoutTools.allowedTools).not.toContain("mcp__matrix-os-ipc__add_app_to_desktop");
    expect(withTools.allowedTools).toContain("mcp__matrix-os-ipc__list_placeable_apps");
    expect(withTools.allowedTools).toContain("mcp__matrix-os-ipc__add_app_to_desktop");
    expect(vi.mocked(createIpcServer)).toHaveBeenLastCalledWith(db, "/home/matrix/home", osViewTools);
  });
});
