import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentThreadSummarySchema } from "@matrix-os/contracts";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createWorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createCodexExecutionSessions } from "../../packages/gateway/src/coding-agents/codex-execution-sessions.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
import { isSessionStartClean } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";

const binding = "a".repeat(64);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "native-prelaunch-absence-"));
  const terminalRuntime = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), writeInput: vi.fn(), listWorkspaces: vi.fn() };
  const worktreeManager = { listWorktrees: vi.fn(), acquireLease: vi.fn(), releaseLease: vi.fn() };
  const managerOptions = { homePath, terminalRuntime, worktreeManager, agentLauncher: { buildLaunch: vi.fn() } };
  const manager = createAgentSessionManager(managerOptions);
  const secondManager = createAgentSessionManager(managerOptions);
  const prepare = vi.fn<() => Promise<string>>(async () => { throw new Error("root unavailable"); });
  const runtimeOptions = { agentSessionManager: manager, worktreeManager, projectManager: { getProject: vi.fn() },
    agentSandbox: { preflight: vi.fn(async () => ({ ok: false, status: 503, error: { code: "sandbox_unavailable", message: "Unavailable" } })), cleanup: vi.fn() }, sessionRuntimeBridge: { registerSession: vi.fn() }, prepareRootChatWorkspace: prepare };
  const runtime = createWorkspaceSessionOrchestrator(runtimeOptions as never);
  const secondRuntime = createWorkspaceSessionOrchestrator({ ...runtimeOptions, agentSessionManager: secondManager } as never);
  const actualAdmission = createCodexExecutionAdmission({ homePath, isOwner: () => true, getSnapshot: vi.fn(), readNativeAccount: vi.fn(),
    stopSession: async id => { if (!(await manager.killSession(id)).ok) throw new Error("unconfirmed"); },
  });
  const sessions = createCodexExecutionSessions(homePath);
  const admission = { ...actualAdmission, start: vi.fn(async (owner: string, id?: string) => { await sessions.register(owner, id, binding); return binding; }), validate: vi.fn(async () => undefined),
    releaseFailedStart: vi.fn(actualAdmission.releaseFailedStart) };
  const events = { healthCheck: vi.fn(), watch: vi.fn(async () => { throw new Error("watch unavailable"); }), unwatch: vi.fn(), markStopped: vi.fn() };
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime, codexAdmission: admission, codexEvents: events as never });
  const input = { ownerScope: { type: "user" as const, id: "owner" }, request: { kind: "agent" as const, agent: "codex" as const, sessionId: "sess_native" } };
  const context = { principal: { userId: "owner", source: "jwt" as const },
    thread: AgentThreadSummarySchema.parse({ id: "thread_native", providerId: "codex", title: "Native", status: "running", attention: "none", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" }),
    request: { providerId: "codex", prompt: "Test", clientRequestId: "req_native" }, now: () => new Date(), nextEventId: () => "evt_native" };
  return { homePath, manager, secondManager, runtime, secondRuntime, provider, input, context, prepare, events, admission, actualAdmission, sessions,
    close: async () => { runtime.close(); secondRuntime.close(); manager.shutdown(); secondManager.shutdown(); await rm(homePath, { recursive: true, force: true }); } };
}

it.each(["root", "sandbox"].flatMap(phase => ["null", "{broken", "absent"].map(record => ({ phase, record }))))("$phase failure preserves uncertain record $record", async ({ phase, record }) => {
  const f = await fixture();
  try {
    await mkdir(join(f.homePath, "system/sessions"), { recursive: true });
    if (record !== "absent") await writeFile(join(f.homePath, "system/sessions/sess_native.json"), record);
    if (phase === "sandbox") f.prepare.mockResolvedValue(f.homePath);
    await f.sessions.register("owner", "sess_native", binding);
    const result = await f.runtime.startSession(f.input);
    expect(isSessionStartClean(result, "owner", "sess_native")).toBe(record === "absent");
    await f.admission.releaseFailedStart("owner", "sess_native", binding, result);
    if (record === "absent") await (await f.actualAdmission.prepareRevocation())();
    else await expect(f.actualAdmission.prepareRevocation()).rejects.toThrow();
  } finally { await f.close(); }
});

it.each(["null", "{broken", "absent"])("watch failure preserves uncertain record %s", async record => {
  const f = await fixture();
  try {
    await mkdir(join(f.homePath, "system/sessions"), { recursive: true });
    if (record !== "absent") await writeFile(join(f.homePath, "system/sessions/sess_native.json"), record);
    await expect(f.provider.startThread(f.context)).rejects.toThrow("watch unavailable");
    if (record === "absent") await (await f.actualAdmission.prepareRevocation())();
    else await expect(f.actualAdmission.prepareRevocation()).rejects.toThrow();
  } finally { await f.close(); }
});

it.each(["watch", "preflight"])("shares pending %s ownership with another manager before a session file exists", async phase => {
  const f = await fixture(); const entered = deferred(), finish = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    const gate = async () => { entered.resolve(); await finish.promise; throw new Error("settled failure"); };
    if (phase === "watch") f.events.watch.mockImplementationOnce(gate);
    else f.prepare.mockImplementationOnce(gate);
    pending = phase === "watch" ? f.provider.startThread(f.context).catch(error => error) : f.runtime.startSession(f.input);
    await entered.promise;
    const competitor = await f.secondRuntime.startSession(f.input).catch(error => error);
    expect(isSessionStartClean(competitor, "owner", "sess_native")).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(phase === "watch" ? 0 : 1);
    expect(f.events.unwatch).not.toHaveBeenCalled();
  } finally { finish.resolve(); await pending; await f.close(); }
});

it("holds the reservation through failed-start registration cleanup", async () => {
  const f = await fixture(); const entered = deferred(), finish = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    f.admission.releaseFailedStart.mockImplementationOnce(async (...args) => {
      entered.resolve(); await finish.promise;
      await f.actualAdmission.releaseFailedStart(...args);
    });
    pending = f.provider.startThread(f.context).catch(error => error);
    await entered.promise;
    await expect(f.provider.startThread(f.context)).rejects.toThrow("unavailable");
    expect(f.admission.start).toHaveBeenCalledTimes(1);
    expect(f.events.watch).toHaveBeenCalledTimes(1);
    expect(f.events.unwatch).toHaveBeenCalledTimes(1);
  } finally { finish.resolve(); await pending; await f.close(); }
});

it("binds start capabilities to one owner, session, invocation and reservation lifetime", async () => {
  const f = await fixture();
  let escaped: Parameters<Parameters<typeof f.manager.withSessionStart>[2]>[0] | undefined;
  try {
    await f.manager.withSessionStart("owner", "sess_native", async scope => {
      escaped = scope;
      await expect(scope.startSession({ kind: "agent", agent: "codex", ownerId: "other", sessionId: "sess_native" })).rejects.toThrow("unavailable");
      await expect(scope.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_other" })).rejects.toThrow("unavailable");
      const result = await scope.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_native", runtimePreference: "background" });
      expect(result).toMatchObject({ ok: false });
      expect(isSessionStartClean(await scope.cleanFailure({}), "owner", "sess_native")).toBe(false);
      await expect(scope.startSession({})).rejects.toThrow("unavailable");
    });
    expect(isSessionStartClean(await escaped!.cleanFailure({}), "owner", "sess_native")).toBe(false);
    await expect(escaped!.startSession({})).rejects.toThrow("unavailable");
  } finally { await f.close(); }
});

it("does not mint a prelaunch proof when dispatch begins during the absence read", async () => {
  const f = await fixture();
  try {
    await f.manager.withSessionStart("owner", "sess_native", async scope => {
      const proof = {};
      const checking = scope.cleanFailure(proof);
      await scope.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_native", runtimePreference: "background" });
      await checking;
      expect(isSessionStartClean(proof, "owner", "sess_native")).toBe(false);
    });
  } finally { await f.close(); }
});
