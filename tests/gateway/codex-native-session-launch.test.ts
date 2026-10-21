import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(native: boolean, denied = false) {
  const homePath = await mkdtemp("/tmp/codex-native-session-"); homes.push(homePath);
  const resolveNativeCodexSubscription = vi.fn(async () => {
    if (denied) throw new Error("native unavailable");
    return native ? { codexHome: `${homePath}/.codex`, expectedPrincipalFingerprint: "a".repeat(64), expectedConsentRevision: 1, expectedConfigurationFingerprint: "b".repeat(64), expectedHarnessInstanceId: "codex_owner_openai_profile", expectedAccountId: "owner_codex" } : undefined;
  });
  const terminalRuntime = {
    ensureWorkspace: vi.fn(async () => ({ id: "tws_00000000000000000000000000000001" })),
    createTab: vi.fn(async () => ({ id: "tt_00000000000000000000000000000001" })),
    terminateTab: vi.fn(), writeInput: vi.fn(), listWorkspaces: vi.fn(async () => []),
  };
  const manager = createAgentSessionManager({ homePath, resolveNativeCodexSubscription, terminalRuntime,
    agentLauncher: createAgentLauncher({ runtimeHome: homePath, codexExecutable: "/tmp/synthetic-codex" }),
    worktreeManager: createWorktreeManager({ homePath, runCommand: vi.fn() }), idGenerator: () => "sess_native_fixture" });
  return { manager, resolveNativeCodexSubscription, terminalRuntime };
}
const request = { kind: "agent", agent: "codex", ownerId: "owner", prompt: "fixture only", sandbox: { enabled: true, mode: "workspace-write" } };
it("propagates only server-admitted native identity through the actual session launcher to env -i", async () => {
  const f = await fixture(true);
  try {
    expect((await f.manager.startSession(request)).ok).toBe(true);
    expect(f.resolveNativeCodexSubscription).toHaveBeenCalledWith("owner", "sess_native_fixture");
    const command = f.terminalRuntime.createTab.mock.calls[0]![1].command;
    expect(command.slice(0, 2)).toEqual(["env", "-i"]);
    expect(command).toContain('forced_login_method="chatgpt"');
    const config = JSON.parse(Buffer.from(command.at(-1), "base64").toString());
    expect(config.expectedNativePrincipal).toBe("a".repeat(64));
  } finally { f.manager.shutdown(); }
});
it("does not accept a forged renderer native mode", async () => {
  const f = await fixture(false);
  try {
    expect((await f.manager.startSession({ ...request, nativeCodexSubscription: { codexHome: "/forged", expectedPrincipalFingerprint: "a".repeat(64), expectedConsentRevision: 1, expectedConfigurationFingerprint: "b".repeat(64), expectedHarnessInstanceId: "codex_owner_openai_profile", expectedAccountId: "owner_codex" } })).ok).toBe(true);
    const command = f.terminalRuntime.createTab.mock.calls[0]![1].command;
    expect(command).not.toContain("-i"); expect(command).not.toContain('forced_login_method="chatgpt"');
  } finally { f.manager.shutdown(); }
});
it("does not acquire a Terminal on failed late admission", async () => {
  const f = await fixture(true, true);
  try {
    expect((await f.manager.startSession(request)).ok).toBe(false);
    expect(f.terminalRuntime.ensureWorkspace).not.toHaveBeenCalled();
    expect(f.terminalRuntime.createTab).not.toHaveBeenCalled();
  } finally { f.manager.shutdown(); }
});
