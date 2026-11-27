import { CODEX_APP_SERVER_CONTRACT } from "../../packages/gateway/src/coding-agents/codex-app-server-version.js";
import { herdrControlParts } from "./fixtures/herdr-chat-control-parts.js";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createAgentLauncher, type AgentLaunchSpec } from "../../packages/gateway/src/agent-launcher.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createCodexMcpRunScope } from "../../packages/gateway/src/chat/codex-mcp-run-scope.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
it("the real deferred session manager serializes only its admitted attempt nonce into native launch", async () => {
  const home = await mkdtemp("/tmp/mx-terminal-manager-"),
    root = join(home, "isolated");
  await mkdir(root);
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner" }),
    sources = createCodexMcpRunScope({ issuer: registry, gatewayPort: 4000 });
  const source = sources.open({
    owner: { type: "personal", ownerId: "owner" },
    chatId: "chat_one",
    runId: "run_one",
    ownerSubmittedHerdrTurn: true as const,
    parts: herdrControlParts(),
    interactionMode: "default",
    permissionMode: "full_access",
    worktreeId: "wt_7777777777777777",
    executionRoot: root,
    signal: new AbortController().signal,
  } as CanonicalProviderRunInput)!;
  const launches: AgentLaunchSpec[] = [],
    runtime = {
      start: vi.fn(async ({ launch }: { launch: AgentLaunchSpec }) => {
        await Promise.resolve();
        launches.push(launch);
        return { id: "bg_" + "1".repeat(32) };
      }),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(async () => true),
    };
  const manager = createAgentSessionManager({
    homePath: home,
    worktreeManager: {} as never,
    agentLauncher: createAgentLauncher({
      runCommand: async () => ({ stdout: "codex-cli " + CODEX_APP_SERVER_CONTRACT.latestVerifiedVersion, stderr: "" }),
    }),
    terminalRuntime: {} as never,
    backgroundRuntime: runtime,
  });
  try {
    const result = await source.withContext(async () => {
      await Promise.resolve();
      return manager.startSession({
        kind: "agent",
        agent: "codex",
        sessionId: "sess_mcp_scope",
        ownerId: "owner",
        workspaceRoot: root,
        prompt: "Synthetic",
        runtimePreference: "background",
        sandbox: { enabled: true, mode: "workspace-write", writableRoots: [root] },
      });
    });
    expect(result).toMatchObject({ ok: true });
    expect(launches).toHaveLength(1);
    const launch = launches[0],
      config = JSON.parse(Buffer.from(launch.args.at(-1)!, "base64").toString("utf8"));
    expect(config.matrixMcpAttemptId).toBe(source.lease.attemptId);
    expect(JSON.stringify(launch)).not.toContain(source.lease.token);
    expect(await readFile(join(home, "system/sessions/sess_mcp_scope.json"), "utf8")).not.toContain(source.lease.token);
    source.close();
  } finally {
    source.close();
    registry.close();
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
