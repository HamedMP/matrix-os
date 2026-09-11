import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSandbox } from "../../packages/gateway/src/agent-sandbox.js";
import { createAgentLauncher } from "../../packages/gateway/src/agent-launcher.js";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createWorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";
import { createWorktreeManager } from "../../packages/gateway/src/worktree-manager.js";

const WORKSPACE_ID = "tws_00000000000000000000000000000001";

describe("cold resume with retained workspace sandbox", () => {
  const homes: string[] = [];
  afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  it.each(["resume", "launch-failure", "public", "foreign-owner", "wrong-thread", "missing-native", "scratch-symlink"])(
    "preserves sandbox ownership during %s", async (scenario) => {
    const homePath = await realpath(await mkdtemp(join(tmpdir(), "matrix-cold-sandbox-")));
    homes.push(homePath);
    const launches: string[][] = [];
    const tabs = new Map<string, { id: string; workspaceId: string; status: "running" }>();
    const terminalRuntime = {
      ensureWorkspace: async () => ({ id: WORKSPACE_ID }),
      createTab: async (_workspaceId: string, input: { command?: string[] }) => {
        if (launches.length && scenario === "launch-failure") throw new Error("runtime unavailable");
        launches.push(input.command ?? []);
        const id = `tt_${launches.length.toString(16).padStart(32, "0")}`;
        const tab = { id, workspaceId: WORKSPACE_ID, status: "running" as const };
        tabs.set(id, tab);
        return tab;
      },
      terminateTab: async ({ tabId }: { tabId: string }) => { tabs.delete(tabId); },
      writeInput: async () => undefined,
      listWorkspaces: async () => [{ id: WORKSPACE_ID, tabs: [...tabs.values()] }],
    };
    const agentSessionManager = createAgentSessionManager({
      homePath,
      worktreeManager: createWorktreeManager({ homePath }),
      agentLauncher: createAgentLauncher({ runtimeHome: homePath }),
      terminalRuntime,
    });
    const orchestrator = createWorkspaceSessionOrchestrator({
      homePath, agentSessionManager,
      agentSandbox: createAgentSandbox({ homePath, getUid: () => 1000 }),
      projectManager: {} as never, worktreeManager: createWorktreeManager({ homePath }),
      sessionRuntimeBridge: {} as never,
    });
    try {
      const request = { sessionId: "sess_resume", kind: "agent" as const, agent: "codex" as const, prompt: "first" };
      expect(await orchestrator.startSession({ ownerScope: { type: "user", id: "owner" }, request })).toMatchObject({ ok: true });
      const retained = join(homePath, "system", "agent-scratch", "sess_resume", "keep.txt");
      await writeFile(retained, "owner scratch content");
      if (scenario === "scratch-symlink") {
        const scratch = join(homePath, "system", "agent-scratch", "sess_resume");
        await rename(scratch, `${scratch}-original`);
        await symlink(`${scratch}-original`, scratch);
      }
      const result = await orchestrator.startSession({
        ownerScope: { type: "user", id: scenario === "foreign-owner" ? "other" : "owner" },
        ...(scenario === "public" ? {} : { recoveryThreadId: scenario === "wrong-thread" ? "thread_other" : "thread_resume" }),
        request: { ...request, prompt: "continue", ...(scenario === "missing-native" ? {} : { providerThreadId: "native_resume" }) },
      });
      expect(result.ok).toBe(scenario === "resume");
      expect(launches).toHaveLength(scenario === "resume" ? 2 : 1);
      if (scenario === "resume") {
        expect(JSON.parse(Buffer.from(launches[1]!.at(-1)!, "base64").toString("utf8")))
          .toMatchObject({ providerThreadId: "native_resume", prompt: "continue" });
      }
      expect(await readFile(retained, "utf8")).toBe("owner scratch content");
    } finally { await orchestrator.close(); }
  });
});
