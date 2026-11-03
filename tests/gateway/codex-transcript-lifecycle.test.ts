import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { createChatIdleReaper } from "../../packages/gateway/src/coding-agents/chat-idle-reaper.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { WorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";
import type { WorkspaceSessionView } from "../../packages/gateway/src/agent-session-manager.js";
import { createSessionStartGuard } from "../../packages/gateway/src/session-start-guard.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { if (await check()) return; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Lifecycle prerequisite did not complete");
}

it.each([
  { legacyLoss: false, fenced: false, pressure: false }, { legacyLoss: false, fenced: false, pressure: true },
  { legacyLoss: true, fenced: false, pressure: false }, { legacyLoss: true, fenced: true, pressure: false },
])("continues the same native conversation after idle hibernation and restart ($legacyLoss/$fenced/$pressure)", async ({ legacyLoss, fenced, pressure }) => {
  const homePath = await mkdtemp("/tmp/mxl-");
  const principal = { userId: "owner_lifecycle", source: "jwt" as const };
  const trace = join(homePath, "native-trace.jsonl");
  let clock = Date.now();
  let child: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  let session!: WorkspaceSessionView;
  let starts = 0;
  const guard = createSessionStartGuard(homePath, async () => !!session);
  const withSessionStart: WorkspaceSessionOrchestrator["withSessionStart"] = (ownerId, sessionId, operation) =>
    guard.reserve(sessionId, ownerId, cleanFailure => operation({ cleanFailure, startSession: input => native.startSession(input) }));
  const native = {
    withSessionStart,
    async startSession({ request }: Parameters<WorkspaceSessionOrchestrator["startSession"]>[0]) {
      starts++;
      const config = Buffer.from(JSON.stringify({ prompt: request.prompt, providerThreadId: request.providerThreadId,
        approvalPolicy: "never", sandbox: "read-only", writableRoots: [homePath] })).toString("base64");
      child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
        codexProviderEventPath(homePath, request.sessionId!), process.version.slice(1), process.execPath,
        join(process.cwd(), "tests/fixtures/codex-transcript-lifecycle-provider.mjs"), config], {
        cwd: homePath, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, MATRIX_TEST_NATIVE_TRACE: trace },
      });
      exited = once(child, "close");
      session = { id: request.sessionId!, ownerId: principal.userId, kind: "agent", agent: "codex",
        attachedClients: 0, lastActivityAt: new Date(clock).toISOString(),
        startedAt: new Date(clock).toISOString(), writeMode: "owner", transcriptPath: join(homePath, "session-output.jsonl"),
        runtime: { type: "background", status: "running", createdAt: new Date(clock).toISOString() },
        backgroundRef: { id: `bg_${String(starts).padStart(32, "0")}` } };
      return { ok: true as const, status: 201, session };
    },
    getSession: async () => ({ ok: true as const, session }),
    listSessions: async () => ({ ok: true as const, sessions: session ? [session] : [] }),
    stopSession: async () => { child?.kill("SIGTERM"); await exited; session.runtime.status = "exited"; return { ok: true as const, session }; },
  };
  const bridgeOptions = { homePath, nowMs: () => clock, pollIntervalMs: 60_000,
    runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) };
  let bridge = createCodexEventBridge(bridgeOptions);
  const control = createCodexControlClient({ homePath });
  const backgroundRuntime = { isRunning: async () => child?.exitCode === null,
    stop: async () => { child?.kill("SIGTERM"); await exited; session.runtime.status = "exited"; } };
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: native,
    backgroundRuntime, codexControl: control, codexEvents: { healthCheck: signal => bridge.healthCheck(signal), watch: input => bridge.watch(input),
      unwatch: id => bridge.unwatch(id), markStopped: id => bridge.markStopped(id), isRuntimeAlive: async () => child?.exitCode === null } });
  let threads = createCodingAgentThreadStore({ homePath, providers: [provider] });
  bridge.attachThreadStore(threads);
  const reaper = createChatIdleReaper({ sessions: native, threads, control, now: () => clock,
    terminalRuntime: { listWorkspaces: async () => [], terminateTab: async () => undefined },
    backgroundRuntime,
    underPressure: async () => false, admitCanonical: async (_identity, reclaim) => reclaim(), unwatch: id => bridge.unwatch(id) });
  try {
    const created = await threads.createThread(principal, { providerId: "codex", prompt: "first request", clientRequestId: "req_first" });
    const threadId = created.snapshot.thread.id;
    const path = codexProviderEventPath(homePath, session.id);
    await waitFor(async () => {
      await bridge.drain();
      return (await threads.getThread(principal, threadId)).thread.status === "completed";
    });
    const originalBytes = (await stat(path)).size;
    expect(originalBytes).toBeGreaterThan(3_000);
    const stored = JSON.parse(await readFile(join(homePath, "system/coding-agents/threads.json"), "utf8"));
    const savedOffset = stored.threads[0].providerEventOffset;
    expect(savedOffset).toBe(originalBytes);
    clock += 6 * 60_000;
    expect((await reaper.sweep()).reclaimed).toBe(1);
    expect(child!.exitCode).toBe(0);
    expect(bridge.watcherCount()).toBe(0);

    // The real retention sweep must retain logs referenced by hibernated threads.
    clock += pressure ? 60 * 60_000 : 8 * 24 * 60 * 60_000;
    if (pressure) await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(join(dirname(path), `sess_orphan_${index}.jsonl`), "orphan\n")));
    await bridge.drain();
    expect((await stat(path)).size).toBe(originalBytes);
    if (pressure) expect((await readdir(dirname(path))).filter(name => name.endsWith(".jsonl"))).toHaveLength(201);
    // Upgrade regression only: an older release may already have removed this log.
    if (legacyLoss) await rm(path);
    await reaper.close();
    await threads.shutdownTurns();
    await bridge.shutdown();
    bridge = createCodexEventBridge(bridgeOptions);
    threads = createCodingAgentThreadStore({ homePath, providers: [provider] });
    bridge.attachThreadStore(threads);
    if (fenced) await threads.ingestProviderEvents(principal, threadId, { events: [
      { type: "thread.error", threadId, eventId: "evt_legacy_error", occurredAt: new Date(clock).toISOString(),
        error: { code: "agent_history_unavailable", safeMessage: "Conversation could not be restored. Start a new chat.", retryable: false, recoveryActions: ["start_new_session"] } },
      { type: "thread.completed", threadId, eventId: "evt_legacy_terminal", occurredAt: new Date(clock).toISOString(), outcome: "failed" },
    ] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const runInput = { owner: { type: "personal" as const, ownerId: principal.userId }, chatId: "chat_lifecycle",
      turnId: "cturn_followup", runId: "run_followup", prompt: "followup request", parts: [{ type: "text" as const, text: "followup request" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised",
      signal: AbortSignal.timeout(4_000), resumeState: { conversationId: threadId } };
    const received: CanonicalProviderRunEvent[] = [];
    const collected = (async () => { for await (const event of adapter.resume!(runInput)) received.push(event); })()
      .then(() => undefined, error => error);
    await waitFor(async () => starts === 2 && (await readFile(path, "utf8")).match(/"type":"turn.completed"/g)?.length === (legacyLoss ? 1 : 2));
    await bridge.drain();
    expect(await collected).toBeUndefined();
    expect(received.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(received.filter(event => event.type === "assistant.delta").map(event => event.delta).join("")).toBe("same conversation continued");
    const requests = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
    expect(requests.find(request => request.method === "thread/resume")?.params.threadId).toBe("native_lifecycle");
    if (legacyLoss) {
      expect((await stat(path)).size).toBeLessThan(originalBytes);
      expect(savedOffset).toBeGreaterThan((await stat(path)).size);
      await expect(threads.ingestProviderEvents(principal, threadId, { events: [] },
        { sessionId: session.id, offset: savedOffset + 1 })).rejects.toThrow("generation changed");
    }

    const resumed = await threads.getThread(principal, threadId);
    expect(resumed.thread.status).toBe("completed");
    expect(resumed.events.items.filter(event => event.type === "assistant.text.delta").map(event => event.delta).join(""))
      .toBe("original answer ".repeat(256) + "same conversation continued");
    for await (const _event of adapter.resume!(runInput)) { /* idempotent request reads the committed outcome */ }
    expect(starts).toBe(2);
  } finally {
    await reaper.close();
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await threads.shutdownTurns();
    await bridge.shutdown();
    await rm(homePath, { recursive: true, force: true });
  }
}, 12_000);

it.each(["missing", "corrupt"])("retains unwatched transcripts when durable inventory is %s", async mode => {
  const homePath = await mkdtemp("/tmp/mxl-");
  const bridge = createCodexEventBridge({ homePath, nowMs: () => Date.now() + 8 * 24 * 60 * 60_000, pollIntervalMs: 60_000,
    runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) });
  const threads = createCodingAgentThreadStore({ homePath, providers: [] });
  try {
    const watched = await bridge.watch({ principal: { userId: "owner", source: "jwt" }, threadId: "thread_retained", sessionId: "sess_retained" });
    await writeFile(watched.path, "retained transcript\n");
    bridge.unwatch("sess_retained");
    if (mode === "corrupt") await writeFile(join(homePath, "system/coding-agents/threads.json"), "invalid inventory");
    bridge.attachThreadStore(threads);
    try { await bridge.drain(); } catch (error) { expect(error).toBeInstanceOf(Error); }
    expect(await readFile(watched.path, "utf8")).toBe("retained transcript\n");
  } finally { await bridge.shutdown(); await rm(homePath, { recursive: true, force: true }); }
});
