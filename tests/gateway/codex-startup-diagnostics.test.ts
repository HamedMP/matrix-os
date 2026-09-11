import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { createAgentSandbox } from "../../packages/gateway/src/agent-sandbox.js";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";
import { createSessionRuntimeBridge } from "../../packages/gateway/src/session-runtime-bridge.js";
import { createWorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";
import { createWorkspaceEventPublisher } from "../../packages/gateway/src/workspace-event-publisher.js";
import { createWorkspaceEventStore } from "../../packages/gateway/src/workspace-events.js";
import { createCodingAgentSessionStopReconciler } from "../../packages/gateway/src/coding-agents/session-stop-reconciler.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { KyselyPGlite } from "kysely-pglite";
import { catalog, owner, principal } from "./helpers/canonical-codex-catalog.js";

const WORKSPACE_ID = "tws_00000000000000000000000000000001";

function createTestTerminalRuntime(options: {
  operations?: string[];
  startError?: Error;
  stopFails?: boolean;
} = {}) {
  const tabs = new Map<string, { id: string; workspaceId: string; status: "running" }>();
  let nextTabId = 1;
  return {
    ensureWorkspace: async () => {
      options.operations?.push("ensure");
      if (options.startError) throw options.startError;
      return { id: WORKSPACE_ID };
    },
    createTab: async () => {
      options.operations?.push("create");
      const id = `tt_${nextTabId.toString(16).padStart(32, "0")}`;
      nextTabId += 1;
      const tab = { id, workspaceId: WORKSPACE_ID, status: "running" as const };
      tabs.set(id, tab);
      return tab;
    },
    terminateTab: async ({ tabId }: { tabId: string }) => {
      options.operations?.push("terminate");
      if (options.stopFails) throw new Error("Stop failed");
      tabs.delete(tabId);
    },
    writeInput: async () => undefined,
    listWorkspaces: async () => [{ id: WORKSPACE_ID, tabs: [...tabs.values()] }],
  };
}

describe("Codex startup failure evidence", () => {
  it.each([false, true])("requires actual terminal tab termination, not an interrupt ACK (stop fails=%s)", async (stopFails) => {
    const homePath = await realpath(await mkdtemp(join(tmpdir(), "codex-stop-")));
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const operations: string[] = [];
    const terminalRuntime = createTestTerminalRuntime({ operations, stopFails });
    const worktreeManager = createWorktreeManager({ homePath });
    const manager = createAgentSessionManager({ homePath, worktreeManager,
      agentLauncher: createAgentLauncher(), terminalRuntime });
    const reconciler = createCodingAgentSessionStopReconciler();
    const publisher = createWorkspaceEventPublisher({ eventStore: createWorkspaceEventStore({ homePath }),
      onSessionStopped: (session) => reconciler.handleSessionStopped(session) });
    const workspace = createWorkspaceSessionOrchestrator({ homePath,
      projectManager: createProjectManager({ homePath }), worktreeManager,
      agentSessionManager: manager, agentSandbox: createAgentSandbox({ homePath, getUid: () => 1000 }),
      sessionRuntimeBridge: createSessionRuntimeBridge(), eventPublisher: publisher });
    const interruptTurn = vi.fn(async () => undefined);
    const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: workspace,
      codexControl: { interruptTurn, submitTurn: async () => undefined, steerTurn: async () => undefined,
        submitApproval: async () => undefined, submitInput: async () => undefined } });
    const threads = createCodingAgentThreadStore({ homePath, providers: [provider] });
    await reconciler.attachThreadStore(threads);
    try {
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
      let conversationId = "";
      let cleanupUnconfirmed = false;
      const consume = async () => {
        for await (const event of adapter.start({ owner, chatId: "chat_stop", turnId: "cturn_stop", runId: "run_stop",
          prompt: "Inspect", parts: [{ type: "text", text: "Inspect" }],
          selection: { instanceId: "codex_default", model: "model" }, interactionMode: "default",
          permissionMode: "supervised", signal: new AbortController().signal,
          onCleanupUnconfirmed: () => { cleanupUnconfirmed = true; } })) {
          if (event.type === "state.updated") conversationId = adapter.parseState(event.state).conversationId;
          if (event.type === "terminal.bound") break;
        }
      };
      if (stopFails) await expect(consume()).rejects.toThrow();
      else await consume();
      expect(operations).toContain("create");
      expect(operations).toContain("terminate");
      expect(interruptTurn).not.toHaveBeenCalled();
      expect(cleanupUnconfirmed).toBe(stopFails);
      expect((await threads.getThread(principal, conversationId)).thread.status).toBe(stopFails ? "running" : "aborted");
    } finally {
      reconciler.dispose();
      await workspace.close();
      await threads.shutdownTurns();
      warnings.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("retains the failed system launch cause correlated to the thread without leaking it to Chat", async () => {
    const homePath = await realpath(await mkdtemp(join(tmpdir(), "codex-startup-")));
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const terminalRuntime = createTestTerminalRuntime({
      startError: Object.assign(new Error("spawn denied token=private-token /opt/private"), { code: "EAGAIN" }),
    });
    const worktreeManager = createWorktreeManager({ homePath });
    const manager = createAgentSessionManager({ homePath, worktreeManager,
      agentLauncher: createAgentLauncher(), terminalRuntime });
    const workspace = createWorkspaceSessionOrchestrator({ homePath,
      projectManager: createProjectManager({ homePath }), worktreeManager,
      agentSessionManager: manager, agentSandbox: createAgentSandbox({ homePath, getUid: () => 1000 }),
      sessionRuntimeBridge: createSessionRuntimeBridge() });
    const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: workspace });
    const threads = createCodingAgentThreadStore({ homePath, providers: [provider] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog },
      adapters: new CanonicalChatProviderRegistry([adapter]) });
    try {
      await repository.create(owner, { id: "chat_startup", clientRequestId: "req_startup", title: "Startup" });
      const admission = await orchestrator.admitTurn(principal, owner, "chat_startup", {
        clientRequestId: "req_inspect", baseRevision: 0, parts: [{ type: "text", text: "Inspect runtime" }],
        selection: { instanceId: "codex_default", model: "model" }, interactionMode: "default",
        permissionMode: "supervised" });
      await orchestrator.drain();
      const persisted = await repository.exportChat(owner, "chat_startup");
      expect(persisted?.runs.map((run) => run.status)).toEqual(["failed"]);
      expect(persisted?.activities.some((event) => event.type === "terminal.bound")).toBe(false);
      expect(await manager.listSessions()).toMatchObject({ ok: true, sessions: [] });
      const record = await repository.getAdapterState(owner, { runId: admission.run.id,
        driverKind: "codex", instanceId: "codex_default" });
      const state = adapter.parseState(record!.state);
      const sessionId = `sess_${state.conversationId.slice(7)}`;
      const diagnostic = warnings.mock.calls.map((call) => call[1]).find((value) => value?.stage === "runtime_start");
      expect(diagnostic).toMatchObject({ sessionId });
      expect(JSON.stringify(diagnostic)).toContain("EAGAIN");
      expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/private-token|\/opt\/private/);
      expect(JSON.stringify(persisted)).not.toMatch(/EAGAIN|private-token|\/opt\/private/);
    } finally {
      await orchestrator.close();
      await workspace.close();
      await threads.shutdownTurns();
      await repository.kysely.destroy();
      warnings.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
