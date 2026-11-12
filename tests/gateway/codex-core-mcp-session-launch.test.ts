import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";

// Spec 2691 checkpoint: a Codex session launch contains the scoped Matrix Core
// server and a live run bearer for it; a failed start leaves no live bearer.
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const owner = { type: "personal" as const, ownerId: "owner_codex_core" };

async function fixture(createTabFails = false) {
  const homePath = await mkdtemp("/tmp/codex-core-mcp-session-"); homes.push(homePath);
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
  const terminalRuntime = {
    ensureWorkspace: vi.fn(async () => ({ id: "tws_00000000000000000000000000000001" })),
    createTab: vi.fn(async () => {
      if (createTabFails) throw new Error("terminal unavailable");
      return { id: "tt_00000000000000000000000000000001" };
    }),
    terminateTab: vi.fn(), writeInput: vi.fn(), listWorkspaces: vi.fn(async () => []),
  };
  const manager = createAgentSessionManager({ homePath, terminalRuntime,
    agentLauncher: createAgentLauncher({ runtimeHome: homePath, codexExecutable: "/tmp/synthetic-codex" }),
    worktreeManager: createWorktreeManager({ homePath, runCommand: vi.fn() }), idGenerator: () => "sess_core_fixture",
    issueMatrixCoreMcp: ({ ownerId, sessionId, readOnly }) => {
      const grant = registry.issue({ owner: { type: "personal", ownerId }, runId: sessionId, scope: readOnly ? "discovery" : "call" });
      return grant ? { token: grant.token, scope: readOnly ? "discovery" : "call", revoke: grant.revoke } : null;
    } });
  return { manager, registry, terminalRuntime };
}

function tokenFrom(command: string[]): string {
  return command.find(part => part.startsWith("MATRIX_AGENT_INTEGRATIONS_TOKEN="))!.split("=")[1]!;
}

it.each([
  ["workspace-write", "call", "--tool-surface=custom-mcp-call"],
  ["read-only", "discovery", "--tool-surface=custom-mcp-discovery"],
] as const)("launches a %s Codex session with the scoped %s Core server and a live run bearer", async (mode, scope, surface) => {
  const f = await fixture();
  try {
    const started = await f.manager.startSession({ kind: "agent", agent: "codex", ownerId: owner.ownerId, prompt: "fixture only",
      sandbox: { enabled: true, mode } });
    expect(started.ok).toBe(true);
    const command = f.terminalRuntime.createTab.mock.calls[0]![1].command as string[];
    expect(command).toContain(`mcp_servers.matrix-integrations.args=["--require-scoped-capability","${surface}","--harness=codex"]`);
    expect(command).toContain("MATRIX_MCP_HARNESS=codex");
    expect(f.registry.resolveRunContext(tokenFrom(command), "GET", "/api/mcp-servers/core/services"))
      .toMatchObject({ actorId: owner.ownerId, runId: "sess_core_fixture", scope });
  } finally { f.manager.shutdown(); f.registry.close(); }
});

it("revokes the Core bearer when the Codex terminal cannot start", async () => {
  const f = await fixture(true);
  try {
    expect((await f.manager.startSession({ kind: "agent", agent: "codex", ownerId: owner.ownerId, prompt: "fixture only",
      sandbox: { enabled: true, mode: "workspace-write" } })).ok).toBe(false);
    const command = f.terminalRuntime.createTab.mock.calls[0]![1].command as string[];
    expect(f.registry.resolve(tokenFrom(command), "GET", "/api/mcp-servers/core/services")).toBeNull();
  } finally { f.manager.shutdown(); f.registry.close(); }
});

it("revokes the Core bearer when a running Codex session is stopped normally", async () => {
  // Fault: a stopped session's bearer stays usable until its 35-minute TTL.
  const f = await fixture();
  try {
    expect((await f.manager.startSession({ kind: "agent", agent: "codex", ownerId: owner.ownerId, prompt: "fixture only",
      sandbox: { enabled: true, mode: "workspace-write" } })).ok).toBe(true);
    const token = tokenFrom(f.terminalRuntime.createTab.mock.calls[0]![1].command as string[]);
    expect(f.registry.resolve(token, "GET", "/api/mcp-servers/core/services")).toBe(owner.ownerId);
    expect((await f.manager.killSession("sess_core_fixture")).ok).toBe(true);
    expect(f.terminalRuntime.terminateTab).toHaveBeenCalled();
    expect(f.registry.resolve(token, "GET", "/api/mcp-servers/core/services")).toBeNull();
  } finally { f.manager.shutdown(); f.registry.close(); }
});

it("revokes live Core bearers when the session manager shuts down", async () => {
  const f = await fixture();
  try {
    await f.manager.startSession({ kind: "agent", agent: "codex", ownerId: owner.ownerId, prompt: "fixture only",
      sandbox: { enabled: true, mode: "workspace-write" } });
    const token = tokenFrom(f.terminalRuntime.createTab.mock.calls[0]![1].command as string[]);
    f.manager.shutdown();
    expect(f.registry.resolve(token, "GET", "/api/mcp-servers/core/services")).toBeNull();
  } finally { f.registry.close(); }
});
