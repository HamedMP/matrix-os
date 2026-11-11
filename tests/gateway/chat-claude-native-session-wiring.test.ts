import { EventEmitter } from "node:events";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { resolveClaudeSessionSource } from "../../packages/gateway/src/chat/claude-session-source.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";
import { CanonicalCliError, type CanonicalCliSpawn, type runCanonicalCli } from "../../packages/gateway/src/chat/cli-process.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
const resolveNativeProtocol = async () => ({ command: "/qualified/claude", qualified: true });

type Turn = Parameters<typeof runCanonicalCli>[0] & { input: CanonicalProviderRunInput; sourceFingerprint: string; schedulingAllowed?: boolean };
const input: CanonicalProviderRunInput = { owner: { type: "personal", ownerId: "owner_a" }, chatId: "chat_a", turnId: "cturn_a", runId: "run_a",
  prompt: "hello", parts: [{ type: "text", text: "hello" }], selection: { instanceId: "claude_code_default", model: "haiku", options: [] },
  interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
const frame = (o: unknown) => Buffer.from(JSON.stringify(o) + "\n");
function fallbackChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    stdin: { write: (_s: string, cb?: (e?: Error) => void) => { cb?.(); return true; }, end: vi.fn() } });
  queueMicrotask(() => { child.stdout.emit("data", frame({ type: "result", subtype: "success", result: "fallback", session_id: "session_a" })); child.emit("exit", 0, null); });
  return child;
}
const spawnFn = (() => fallbackChild()) satisfies CanonicalCliSpawn;
function pool(run = async (o: Turn) => {
  o.onStart?.(async () => {}, vi.fn(), { pause() {}, resume() {} }, { ready() {} });
  o.onStdout(frame({ type: "system", subtype: "init", session_id: "session_a" }));
  o.onStdout(frame({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "streamed reply" } } }));
  o.onStdout(frame({ type: "result", subtype: "success", result: "streamed reply", session_id: "session_a" }));
  o.onSettled?.();
}) {
  return { runTurn: vi.fn(run), hasProtectedSession: vi.fn(() => false), setScheduledHandler: vi.fn(),
    retireIdle: vi.fn(async () => {}), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}
async function collect(events: AsyncIterable<unknown>) { const out = []; for await (const e of events) out.push(e); return out; }

describe("Claude protected recovery launch plan", () => {
  const sessionId = "8b375f9b-4d46-43ab-8c91-2c7196a2d6b1";
  const timestamp = "2026-11-11T01:30:00.000Z";
  const run: CanonicalChatRun = { id: input.runId, chatId: input.chatId, turnId: input.turnId, attempt: 1,
    driverKind: "claude_code", instanceId: input.selection.instanceId, selection: input.selection,
    interactionMode: input.interactionMode, permissionMode: input.permissionMode, status: "completed", outcome: "completed",
    historyBoundarySeq: 0, startedAt: timestamp, completedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, capabilitySnapshot: {
      revision: "rev_a", rootChat: true, attachments: [], resources: [], tools: [], approvals: true, userInput: true,
      resume: true, cancellation: true, worktrees: "optional", interactionModes: ["default"], permissionModes: ["supervised"],
    } };

  it("reproduces the completed Run source with Browser configured without opening any Run capability", async () => {
    const nativeSessions = pool();
    const spawn = vi.fn(spawnFn);
    const matrixMcp = createMatrixMcpCapabilityRegistry({ configuredOwnerId: input.owner.ownerId });
    const issue = vi.spyOn(matrixMcp, "issue");
    const browser = createSharedBrowserBroker({ ownerId: input.owner.ownerId, driver: {
      execute: async () => ({ success: true }), detach: async () => {}, invalidateObservation() {},
    }, setHumanControl: async () => {} });
    const open = vi.spyOn(browser, "openRun");
    let credential = "owner-key";
    const resolveCredentialLaunch = vi.fn(async () => ({ env: {
      ANTHROPIC_API_KEY: credential, MATRIX_AUTH_TOKEN: "ambient-host-secret", MATRIX_AGENT_INTEGRATIONS_TOKEN: "ambient-run-secret",
      MATRIX_SHARED_BROWSER_TOKEN: "ambient-browser-secret", UNKNOWN_RUNTIME_TOKEN: "ambient-extra-secret",
    } }));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn: spawn, nativeSessions, resolveNativeProtocol,
      resolveCredentialLaunch, matrixMcpCapabilityIssuer: matrixMcp, sharedBrowser: browser });
    try {
      await collect(adapter.start(input));
      const original = nativeSessions.runTurn.mock.calls[0]![0];
      expect(original.schedulingAllowed).toBe(true);
      expect(original.args).toContain("--mcp-config");
      expect(issue).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledOnce();
      const recovery = { owner: input.owner, run, state: { sessionId }, sessionId,
        expectedSourceFingerprint: original.sourceFingerprint, signal: input.signal };
      const plan = await adapter.prepareNativeRecovery(recovery);
      expect(plan).toMatchObject({ command: "/qualified/claude", cwd: "/owner", sessionId, sourceFingerprint: original.sourceFingerprint,
        env: { ANTHROPIC_API_KEY: "owner-key", HOME: "/owner" } });
      expect(plan?.args).toEqual(original.args.filter((_arg, index, args) =>
        args[index] !== "--mcp-config" && args[index - 1] !== "--mcp-config"));
      expect(plan?.args).not.toContain("--resume");
      expect(JSON.stringify(plan)).not.toContain("ambient-");
      expect(resolveCredentialLaunch).toHaveBeenLastCalledWith({ runId: input.runId, instanceId: input.selection.instanceId });
      expect(issue).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledOnce();
      expect(nativeSessions.runTurn).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();

      credential = "different-owner-key";
      await expect(adapter.prepareNativeRecovery(recovery)).resolves.toBeNull();
    } finally {
      await browser.close();
      matrixMcp.close();
    }
  });

  it("refuses unsupported sources before credentials or native probes, and rejects funded and unqualified launches", async () => {
    const resolveCredentialLaunch = vi.fn<NonNullable<Parameters<typeof createClaudeChatProviderAdapter>[0]["resolveCredentialLaunch"]>>(
      async () => ({ env: { ANTHROPIC_API_KEY: "owner-key" } }),
    );
    const qualify = vi.fn(resolveNativeProtocol);
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", resolveCredentialLaunch, resolveNativeProtocol: qualify });
    const recovery = { owner: input.owner, run, state: { sessionId }, sessionId,
      expectedSourceFingerprint: "a".repeat(64), signal: input.signal };
    await expect(adapter.prepareNativeRecovery({ ...recovery, run: { ...run, status: "running" } })).resolves.toBeNull();
    await expect(adapter.prepareNativeRecovery({ ...recovery, state: { sessionId: "other" } })).resolves.toBeNull();
    await expect(adapter.prepareNativeRecovery({ ...recovery, executionRoot: "/unbound" })).resolves.toBeNull();
    await expect(adapter.prepareNativeRecovery({ ...recovery, run: { ...run, instanceId: "claude_code_matrix_included",
      selection: { ...run.selection, instanceId: "claude_code_matrix_included" } } })).resolves.toBeNull();
    expect(resolveCredentialLaunch).not.toHaveBeenCalled();
    expect(qualify).not.toHaveBeenCalled();

    resolveCredentialLaunch.mockResolvedValueOnce({ env: { ANTHROPIC_API_KEY: "funded" }, fundedRunTimeoutMs: 20_000 });
    await expect(adapter.prepareNativeRecovery(recovery)).resolves.toBeNull();
    expect(qualify).not.toHaveBeenCalled();

    qualify.mockResolvedValueOnce({ command: "/unknown/claude", qualified: false });
    await expect(adapter.prepareNativeRecovery(recovery)).resolves.toBeNull();
    expect(qualify).toHaveBeenCalledOnce();
  });

  it("requires a fresh proof of the original native subscription principal", async () => {
    const nativeSessions = pool();
    let principal = "original-account-and-organization";
    let current = true;
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", nativeSessions, resolveNativeProtocol,
      resolveCredentialLaunch: async () => ({ env: {} }),
      resolveSessionSource: source => resolveClaudeSessionSource({ ...source, readNativeMetadata: async () =>
        bindNativeAccountMetadata({ accountLabel: "same-display@example.test", authMethod: "terminal",
          connectionDetails: { email: "same-display@example.test" }, checkedAt: timestamp, staleAfter: timestamp },
        async () => current, principal) }),
    });
    await collect(adapter.start(input));
    const { sourceFingerprint } = nativeSessions.runTurn.mock.calls[0]![0];
    const recovery = { owner: input.owner, run, state: { sessionId }, sessionId,
      expectedSourceFingerprint: sourceFingerprint, signal: input.signal };
    await expect(adapter.prepareNativeRecovery(recovery)).resolves.toMatchObject({ sourceFingerprint });
    principal = "changed-account-or-organization";
    await expect(adapter.prepareNativeRecovery(recovery)).resolves.toBeNull();
    principal = "original-account-and-organization";
    current = false;
    await expect(adapter.prepareNativeRecovery(recovery)).resolves.toBeNull();
  });

  it("interrupts a stalled credential read without reaching the native version probe", async () => {
    let release!: () => void;
    const resolveCredentialLaunch = vi.fn(async () => {
      await new Promise<void>(done => { release = done; });
      return { env: { ANTHROPIC_API_KEY: "owner-key" } };
    });
    const qualify = vi.fn(resolveNativeProtocol);
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", resolveCredentialLaunch, resolveNativeProtocol: qualify });
    const controller = new AbortController();
    const preparing = adapter.prepareNativeRecovery({ owner: input.owner, run, state: { sessionId }, sessionId,
      expectedSourceFingerprint: "a".repeat(64), signal: controller.signal });
    await vi.waitFor(() => expect(resolveCredentialLaunch).toHaveBeenCalledOnce());
    controller.abort();
    try {
      await expect(preparing).rejects.toThrow("Operation interrupted or timed out");
    } finally {
      release();
    }
    expect(qualify).not.toHaveBeenCalled();
  }, 300);
});

describe("Claude per-phase adapter wiring", () => {
  it("includes the native schedule lifetime in the canonical activity events", async () => {
    const nativeSessions = pool(async o => {
      o.onStdout(frame({ type: "system", subtype: "init", session_id: "session_a" }));
      o.onStdout(frame({ type: "stream_event", event: { type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "cron_tool", name: "CronCreate", input: {} } } }));
      o.onStdout(frame({ type: "stream_event", event: { type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: '{"prompt":"private reminder"}' } } }));
      o.onStdout(frame({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }));
      o.onStdout(frame({ type: "result", subtype: "success", result: "Done", session_id: "session_a" }));
      o.onSettled?.();
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol,
      resolveCredentialEnv: async () => ({ HOME: "/owner", PATH: "/bin", ANTHROPIC_API_KEY: "selected-owner-key" }) });
    const events = await collect(adapter.start(input));
    const activities = events.filter(event => (event as { type?: string }).type === "agent.activity");
    expect(activities).toHaveLength(2);
    for (const activity of activities) {
      expect(activity).toMatchObject({ label: "Schedule in this Claude session",
        detail: expect.stringContaining("restart or update can stop it") });
      expect(JSON.stringify(activity)).not.toContain("private reminder");
    }
  });

  it("reports owner cancellation during a held protocol probe as aborted", async () => {
    const nativeSessions = pool(); const fallbackSpawn = vi.fn(spawnFn);
    let release!: () => void;
    const qualify = vi.fn(async () => { await new Promise<void>(done => { release = done; }); return { command: "/old/claude", qualified: false }; });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn: fallbackSpawn, nativeSessions,
      resolveNativeProtocol: qualify, resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    const completion = collect(adapter.start(input));
    await vi.waitFor(() => expect(qualify).toHaveBeenCalledOnce());
    await adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId }); release();
    expect((await completion).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    expect(fallbackSpawn).not.toHaveBeenCalled(); expect(nativeSessions.runTurn).not.toHaveBeenCalled();
  });
  it("preserves B's ordinary input after a negative hook ACK on an unqualified version", async () => {
    const nativeSessions = pool();
    const fallbackSpawn: CanonicalCliSpawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
        stdin: { write(raw: string, cb?: (e?: Error) => void) {
          cb?.(); const value = JSON.parse(raw);
          queueMicrotask(() => {
            if (value.type === "control_request") child.stdout.emit("data", frame({ type: "control_response", response: { request_id: value.request_id, subtype: "success", response: { hooks_applied: false } } }));
            else if (value.type === "user") { child.stdout.emit("data", frame({ type: "result", subtype: "success", result: "ordinary reply", session_id: "session_a" })); child.emit("exit", 0, null); }
          }); return true;
        }, end: vi.fn() } });
      return child;
    };
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn: fallbackSpawn, nativeSessions,
      routineCli: { runtime: {} as never, binPath: "/matrix", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute" },
      resolveNativeProtocol: async () => ({ command: "/old/claude", qualified: false }),
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    expect((await collect(adapter.start(input))).at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(nativeSessions.runTurn).not.toHaveBeenCalled();
  });
  it("does not start ordinary Chat after qualification is aborted", async () => {
    const nativeSessions = pool(); const fallbackSpawn = vi.fn(spawnFn); const signal = new AbortController();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn: fallbackSpawn, nativeSessions,
      resolveNativeProtocol: async () => { signal.abort(); return { command: "/old/claude", qualified: false }; },
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    await collect(adapter.start({ ...input, signal: signal.signal }));
    expect(nativeSessions.runTurn).not.toHaveBeenCalled(); expect(fallbackSpawn).not.toHaveBeenCalled();
  });
  it("keeps ordinary Chat on the original transport when native protocol qualification is unknown", async () => {
    const nativeSessions = pool();
    const fallbackSpawn = vi.fn(spawnFn);
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn: fallbackSpawn, nativeSessions,
      resolveNativeProtocol: async () => ({ command: "/unknown/claude", qualified: false }),
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    const events = await collect(adapter.start(input));
    expect(nativeSessions.runTurn).not.toHaveBeenCalled();
    expect(fallbackSpawn.mock.calls[0]![0]).toBe("/unknown/claude");
    expect(fallbackSpawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(["--disallowedTools", "CronCreate"]));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });
  it.each([{}, { canonicalHistoryRequired: true }] as const)("cancels a held due prompt on an unknown native version (%j)", async marker => {
    const nativeSessions = pool(); const fallbackSpawn = vi.fn(spawnFn);
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn: fallbackSpawn, nativeSessions,
      resolveNativeProtocol: async () => ({ command: "/unknown/claude", qualified: false }),
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    const events = await collect(adapter.resume!({ ...input, runId: "run_due", nativeScheduled: { sourceRunId: "run_a", sessionId: "session_a", promptId: "11111111-1111-4111-8111-111111111111" }, resumeState: { sessionId: "session_a", ...marker } }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { code: "run_failed" } });
    expect(nativeSessions.cancel).toHaveBeenCalledExactlyOnceWith({ owner: input.owner, chatId: input.chatId, runId: "run_a" });
    expect(nativeSessions.runTurn).not.toHaveBeenCalled(); expect(fallbackSpawn).not.toHaveBeenCalled();
  });

  it("uses the retained transport without changing streaming or canonical completion", async () => {
    const nativeSessions = pool();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol,
      resolveCredentialEnv: async () => ({ HOME: "/owner", PATH: "/bin", ANTHROPIC_API_KEY: "selected-owner-key" }) });
    const events = await collect(adapter.start(input));
    expect(nativeSessions.runTurn).toHaveBeenCalledOnce();
    expect(nativeSessions.runTurn.mock.calls[0]![0]).toMatchObject({ input, schedulingAllowed: true, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.delta", delta: "streamed reply" }));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });
  it("gives each new scheduled phase its exact identity and a fresh grant, revoking the prior phase", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_a" });
    const seen: string[] = [];
    const nativeSessions = pool(async o => {
      const token = o.env.MATRIX_AGENT_INTEGRATIONS_TOKEN!; seen.push(token);
      expect(registry.resolve(token, "GET", "/api/mcp-servers")).toBe("owner_a");
      if (seen.length > 1) expect(registry.resolve(seen[0]!, "GET", "/api/mcp-servers")).toBeNull();
      o.onStart?.(async () => {}, () => {}, { pause() {}, resume() {} }, { ready() {} });
      o.onStdout(frame({ type: "result", subtype: "success", result: "phase reply", session_id: "session_a" })); o.onSettled?.();
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol, matrixMcpCapabilityIssuer: registry,
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "selected-owner-key" }) });
    await collect(adapter.start(input));
    const nativeScheduled = { sourceRunId: "run_a", sessionId: "session_a", promptId: "11111111-1111-4111-8111-111111111111" };
    await collect(adapter.resume!({ ...input, runId: "run_due", turnId: "cturn_due", nativeScheduled, resumeState: { sessionId: "session_a" } }));
    expect(nativeSessions.runTurn.mock.calls[1]![0].input.nativeScheduled).toEqual(nativeScheduled);
    expect(seen[0]).not.toBe(seen[1]);
    expect(registry.resolve(seen[1]!, "GET", "/api/mcp-servers")).toBeNull();
    registry.close();
  });
  it("retains ordinary Chat on an unavailable native identity but disables Cron admission", async () => {
    const nativeSessions = pool();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol,
      resolveSessionSource: async () => ({ fingerprint: "unavailable-source", schedulingAllowed: false }),
      resolveCredentialEnv: async () => ({ HOME: "/owner" }) });
    expect((await collect(adapter.start(input))).at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(nativeSessions.runTurn.mock.calls[0]![0].schedulingAllowed).toBe(false);
  });
  it.each(["credentials", "source"])("stops the exact held source on an early %s preparation failure", async stage => {
    const nativeSessions = pool();
    const setupFailure = new Error(`${stage} setup unavailable`);
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol,
      resolveCredentialEnv: async () => { if (stage === "credentials") throw setupFailure; return { HOME: "/owner", ANTHROPIC_API_KEY: "key" }; },
      resolveSessionSource: async () => { throw setupFailure; } });
    const due = { ...input, runId: "run_due", turnId: "cturn_due", resumeState: { sessionId: "session_a" },
      nativeScheduled: { sourceRunId: "run_a", sessionId: "session_a", promptId: "11111111-1111-4111-8111-111111111111" } };
    const completion = collect(adapter.resume!(due));
    if (stage === "credentials") await expect(completion).rejects.toBe(setupFailure);
    else expect((await completion).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { code: "run_failed" } });
    expect(nativeSessions.runTurn).not.toHaveBeenCalled();
    expect(nativeSessions.cancel).toHaveBeenCalledExactlyOnceWith({ owner: input.owner, chatId: input.chatId, runId: "run_a" });
  });
  it("treats an owner Steer of a scheduled phase as a new foreground continuation", async () => {
    let count = 0;
    const nativeSessions = pool(async o => {
      count++;
      o.onStart?.(async () => {}, () => {}, { pause() {}, resume() {} }, { ready() {} });
      o.onStdout(frame({ type: "system", subtype: "init", session_id: "session_a" }));
      if (count === 1) return new Promise((_resolve, reject) => o.signal.addEventListener("abort", () => reject(new CanonicalCliError("aborted")), { once: true }));
      o.onStdout(frame({ type: "result", subtype: "success", result: "steered reply", session_id: "session_a" })); o.onSettled?.();
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol,
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    const completion = collect(adapter.resume!({ ...input, nativeScheduled: { sourceRunId: "run_origin", sessionId: "session_a", promptId: "11111111-1111-4111-8111-111111111111" }, resumeState: { sessionId: "session_a" } }));
    await vi.waitFor(() => expect(nativeSessions.runTurn).toHaveBeenCalledOnce());
    await adapter.steer!({ owner: input.owner, chatId: input.chatId, runId: input.runId, turnId: input.turnId,
      clientRequestId: "req_steer", prompt: "owner changed direction", parts: [{ type: "text", text: "owner changed direction" }] });
    expect((await completion).at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(nativeSessions.runTurn.mock.calls[1]![0].input.nativeScheduled).toBeUndefined();
    expect(nativeSessions.runTurn.mock.calls[1]![0].input.prompt).toBe("owner changed direction");
  });
  it("cancels the actual owned native transport and exposes explicit binding and shutdown", async () => {
    const nativeSessions = pool(async o => new Promise((_resolve, reject) => {
      o.onStart?.(async () => {}, () => {}, { pause() {}, resume() {} }, { ready() {} });
      o.signal.addEventListener("abort", () => reject(new CanonicalCliError("aborted")), { once: true });
    }));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, resolveNativeProtocol,
      resolveCredentialEnv: async () => ({ HOME: "/owner", ANTHROPIC_API_KEY: "key" }) });
    const completion = collect(adapter.start(input));
    await vi.waitFor(() => expect(nativeSessions.runTurn).toHaveBeenCalledOnce());
    await adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId });
    expect(nativeSessions.cancel).toHaveBeenCalledWith({ owner: input.owner, chatId: input.chatId, runId: input.runId });
    expect((await completion).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    const handler = vi.fn(async () => {}); adapter.bindNativeScheduledHandler(handler);
    expect(nativeSessions.setScheduledHandler).toHaveBeenCalledWith(handler);
    await adapter.closeNativeSessions(); expect(nativeSessions.close).toHaveBeenCalledOnce();
  });
});
