import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionManager } from "../../packages/gateway/src/agent-session-manager.js";
import { createCodexExecutionSessions } from "../../packages/gateway/src/coding-agents/codex-execution-sessions.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
import { isSessionStartClean } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";
import type { BackgroundAgentRuntime } from "../../packages/gateway/src/background-agent-runtime.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const binding = "a".repeat(64);
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "native-start-admission-"));
  const root = join(homePath, "projects/repo");
  await mkdir(root, { recursive: true });
  await mkdir(join(homePath, "system/sessions"), { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ id: "proj_repo", slug: "repo", name: "Repo", localPath: root,
    addedAt: "2026-04-26T00:00:00Z", updatedAt: "2026-04-26T00:00:00Z", ownerScope: { type: "user", id: "owner" } }));
  const worktreeManager = { listWorktrees: vi.fn(async () => ({ ok: true as const, worktrees: [{ id: "wt_abc123def456", path: root }] })),
    acquireLease: vi.fn(async () => ({ ok: false as const, status: 409, error: { code: "locked", message: "Locked" } })), releaseLease: vi.fn() };
  const terminalRuntime = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), writeInput: vi.fn(), listWorkspaces: vi.fn() };
  const agentLauncher = { buildLaunch: vi.fn(() => ({ command: "codex", args: [], cwd: root, env: {} })) };
  return { homePath, worktreeManager, terminalRuntime, agentLauncher };
}
async function seedSession(homePath: string, id: string, background = false) {
  await writeFile(join(homePath, "system/sessions", `${id}.json`), JSON.stringify({ id, kind: "agent", agent: "codex", ownerId: "owner",
    runtime: { type: background ? "background" : "zellij", status: background ? "running" : "exited" },
    ...(background ? { backgroundRef: { id: `bg_${"a".repeat(32)}` } } : {}),
    transcriptPath: "unused", attachedClients: 0, writeMode: "owner", startedAt: "2026-04-26T00:00:00Z", lastActivityAt: "2026-04-26T00:00:00Z" }));
}

it("does not hold the background lock while waiting for native revocation's session queue", async () => {
  const f = await fixture();
  const resolverEntered = deferred(), resolverContinue = deferred(), stopEntered = deferred();
  let tail: Promise<unknown> = Promise.resolve();
  const runtime: BackgroundAgentRuntime = { start: vi.fn(), stop: vi.fn(async () => undefined), isRunning: vi.fn(async () => false),
    withLock: operation => { const next = tail.then(() => operation(runtime)); tail = next.catch(() => undefined); return next; } };
  let manager!: ReturnType<typeof createAgentSessionManager>;
  const sessions = createCodexExecutionSessions(f.homePath, async id => {
    stopEntered.resolve();
    const result = await manager.killSession(id);
    if (!result.ok) throw new Error("stop failed");
  });
  manager = createAgentSessionManager({ ...f, backgroundRuntime: runtime, resolveNativeCodexSubscription: async () => {
    resolverEntered.resolve(); await resolverContinue.promise;
    await sessions.get("sess_new"); // Actual admission queue read, never under the background lock.
    return undefined;
  } });
  let start: Promise<unknown> | undefined, revoke: Promise<unknown> | undefined;
  try {
    await seedSession(f.homePath, "sess_old", true);
    await sessions.register("owner", "sess_old", binding);
    start = manager.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_new", runtimePreference: "background" });
    await resolverEntered.promise;
    revoke = sessions.prepareRevocation();
    await stopEntered.promise;
    resolverContinue.resolve();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([revoke.then(() => "drained", () => "failed"),
        new Promise(resolve => { timeout = setTimeout(() => resolve("blocked"), 1500); }),
      ]);
      expect(result).toBe("drained");
    } finally { clearTimeout(timeout); }
    expect(await start).toMatchObject({ ok: false }); // Marker fences admission after stop, before spawning.
    expect(runtime.start).not.toHaveBeenCalled();
  } finally {
    resolverContinue.resolve();
    await Promise.allSettled([start, revoke]);
    manager.shutdown(); await rm(f.homePath, { recursive: true, force: true });
  }
}, 10000);

it.each([false, true])("only proves an absent worktree-lease failure clean (existing: %s)", async existing => {
  const f = await fixture();
  const manager = createAgentSessionManager(f);
  const stopSession = vi.fn(async () => { throw new Error("unknown missing child"); });
  const admission = createCodexExecutionAdmission({ homePath: f.homePath, isOwner: () => true, stopSession, getSnapshot: vi.fn(), readNativeAccount: vi.fn() });
  try {
    if (existing) await seedSession(f.homePath, "sess_lease");
    await createCodexExecutionSessions(f.homePath).register("owner", "sess_lease", binding);
    const result = await manager.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_lease", projectSlug: "repo", worktreeId: "wt_abc123def456" });
    expect(result).toMatchObject({ ok: false, error: { code: "worktree_locked" } });
    expect(isSessionStartClean(result, "owner", "sess_lease")).toBe(!existing);
    await admission.releaseFailedStart("owner", "sess_lease", binding, result);
    if (existing) await expect(admission.prepareRevocation()).rejects.toThrow("unavailable");
    else { await (await admission.prepareRevocation())(); expect(stopSession).not.toHaveBeenCalled(); }
  } finally { manager.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
});

it.each(["owner", "another_owner"])("does not prove a duplicate attempt clean while the same session is awaiting admission (%s)", async duplicateOwner => {
  const f = await fixture();
  const entered = deferred(), finish = deferred();
  const manager = createAgentSessionManager({ ...f, resolveNativeCodexSubscription: async () => { entered.resolve(); await finish.promise; throw new Error("denied"); } });
  let first: Promise<unknown> | undefined;
  try {
    first = manager.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_pending" });
    await entered.promise;
    const duplicate = await manager.startSession({ kind: "agent", agent: "codex", sessionId: "sess_pending", ownerId: duplicateOwner, projectSlug: "repo", worktreeId: "wt_abc123def456" });
    expect(duplicate).toMatchObject({ ok: false });
    expect(isSessionStartClean(duplicate, "owner", "sess_pending")).toBe(false);
    expect(f.worktreeManager.acquireLease).not.toHaveBeenCalled();
  } finally { finish.resolve(); await first; manager.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
});

it.each(["workspace", "project", "worktree", "runtime"])("proves settled absent %s prelaunch failure without acquiring a child", async phase => {
  const f = await fixture();
  if (phase === "worktree") f.worktreeManager.listWorktrees.mockResolvedValue({ ok: true, worktrees: [] });
  const manager = createAgentSessionManager(f);
  try {
    const result = await manager.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_prelaunch",
      ...(phase === "workspace" ? { workspaceRoot: "/outside-home" } : phase === "project" ? { projectSlug: "missing" }
        : phase === "worktree" ? { projectSlug: "repo", worktreeId: "wt_abc123def456" } : { runtimePreference: "background" }),
    });
    expect(result).toMatchObject({ ok: false });
    expect(isSessionStartClean(result, "owner", "sess_prelaunch")).toBe(true);
    expect(f.terminalRuntime.createTab).not.toHaveBeenCalled();
  } finally { manager.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
});

it("does not treat a persisted invalid record as proven absence", async () => {
  const f = await fixture();
  const manager = createAgentSessionManager(f);
  try {
    await writeFile(join(f.homePath, "system/sessions/sess_unknown.json"), "null");
    const result = await manager.startSession({ kind: "agent", agent: "codex", ownerId: "owner", sessionId: "sess_unknown", projectSlug: "missing" });
    expect(result).toMatchObject({ ok: false });
    expect(isSessionStartClean(result, "owner", "sess_unknown")).toBe(false);
  } finally { manager.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
});

it("keeps unknown missing-record revocation fenced without private startup proof", async () => {
  const f = await fixture();
  const manager = createAgentSessionManager(f);
  const admission = createCodexExecutionAdmission({ homePath: f.homePath, isOwner: () => true, getSnapshot: vi.fn(), readNativeAccount: vi.fn(),
    stopSession: async id => { if (!(await manager.killSession(id)).ok) throw new Error("stop unconfirmed"); },
  });
  try {
    await createCodexExecutionSessions(f.homePath).register("owner", "sess_unknown", binding);
    const missing = await manager.killSession("sess_unknown");
    expect(missing).toMatchObject({ ok: false, status: 404 });
    await admission.releaseFailedStart("owner", "sess_unknown", binding, missing);
    await expect(admission.prepareRevocation()).rejects.toThrow("unavailable");
    await expect(createCodexExecutionSessions(f.homePath).assertOpen()).rejects.toThrow("unavailable");
  } finally { manager.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
});
