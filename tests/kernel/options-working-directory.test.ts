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
  createDocumentApprovalHook: vi.fn(() => vi.fn()),
}));

vi.mock("../../packages/kernel/src/evolution.js", () => ({
  createProtectedFilesHook: vi.fn(() => vi.fn()),
}));

import {
  kernelOptions,
  type KernelConfig,
} from "../../packages/kernel/src/options.js";
import { createIpcServer } from "../../packages/kernel/src/ipc-server.js";
import { createDocumentApprovalHook } from "../../packages/kernel/src/hooks.js";

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
    expect(vi.mocked(createIpcServer)).toHaveBeenLastCalledWith(db, "/home/matrix/home", osViewTools, undefined, undefined, undefined);
  });

  it("registers owner audio transcription only from an injected managed dependency", async () => {
    const ownerAudioTranscriber = {
      transcribe: vi.fn(async () => ({ text: "managed", durationMs: 1_000 })),
    };
    await kernelOptions({ db, homePath: "/home/matrix/home", ownerAudioTranscriber });
    expect(vi.mocked(createIpcServer)).toHaveBeenLastCalledWith(
      db,
      "/home/matrix/home",
      undefined,
      ownerAudioTranscriber,
      undefined,
      undefined,
    );
  });

  // Fault detected: the kernel is offered terminal tools it cannot call, or never gets them.
  it("registers terminal tools only when the gateway injects them", async () => {
    const terminalTools = {
      list: vi.fn(), templates: vi.fn(), run: vi.fn(), read: vi.fn(), send: vi.fn(),
      keys: vi.fn(), interrupt: vi.fn(), wait: vi.fn(),
    };
    const withoutTools = await kernelOptions({ db, homePath: "/home/matrix/home" });
    const withTools = await kernelOptions({ db, homePath: "/home/matrix/home", terminalTools: terminalTools as never });
    expect(withoutTools.allowedTools).not.toContain("mcp__matrix-os-ipc__terminal_run");
    expect(withTools.allowedTools).toContain("mcp__matrix-os-ipc__terminal_run");
    expect(withTools.allowedTools).toContain("mcp__matrix-os-ipc__terminal_wait");
    expect(vi.mocked(createIpcServer)).toHaveBeenLastCalledWith(db, "/home/matrix/home", undefined, undefined, terminalTools, undefined);
  });

  // Fault detected: document tools are offered without the service, or accept/reject skip the owner.
  it("registers document tools and their owner approval gate only when the gateway injects them", async () => {
    const documentTools = { request: vi.fn() };
    const requestApproval = vi.fn(async () => true);
    const gate = "mcp__matrix-os-ipc__document_accept_revisions|mcp__matrix-os-ipc__document_reject_revisions|mcp__matrix-os-ipc__sheet_accept_changes|mcp__matrix-os-ipc__sheet_reject_changes";
    const withoutTools = await kernelOptions({ db, homePath: "/home/matrix/home" });
    expect(withoutTools.allowedTools.filter((name) => name.includes("__document_") || name.includes("__sheet_"))).toEqual([]);
    expect(withoutTools.hooks.PreToolUse.map((entry) => entry.matcher)).not.toContain(gate);

    const withTools = await kernelOptions({ db, homePath: "/home/matrix/home", documentTools, requestApproval });
    expect(withTools.allowedTools).toEqual(expect.arrayContaining([
      "mcp__matrix-os-ipc__document_describe", "mcp__matrix-os-ipc__document_propose_edits",
      "mcp__matrix-os-ipc__document_accept_revisions", "mcp__matrix-os-ipc__sheet_reject_changes",
    ]));
    expect(withTools.hooks.PreToolUse.map((entry) => entry.matcher)).toContain(gate);
    expect(vi.mocked(createDocumentApprovalHook)).toHaveBeenLastCalledWith(requestApproval);
    expect(vi.mocked(createIpcServer)).toHaveBeenLastCalledWith(db, "/home/matrix/home", undefined, undefined, undefined, documentTools);

    await kernelOptions({ db, homePath: "/home/matrix/home", documentTools });
    const fallback = vi.mocked(createDocumentApprovalHook).mock.lastCall![0];
    expect(await fallback("mcp__matrix-os-ipc__document_accept_revisions", {})).toBe(false);
  });
});
