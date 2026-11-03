import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { CanonicalCliError, type CanonicalCliSpawn, type runCanonicalCli } from "../../packages/gateway/src/chat/cli-process.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

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
  return { runTurn: vi.fn(run), setScheduledHandler: vi.fn(), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}
async function collect(events: AsyncIterable<unknown>) { const out = []; for await (const e of events) out.push(e); return out; }

describe("Claude per-phase adapter wiring", () => {
  it("uses the retained transport without changing streaming or canonical completion", async () => {
    const nativeSessions = pool();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions,
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
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions, matrixMcpCapabilityIssuer: registry,
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
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions,
      resolveSessionSource: async () => ({ fingerprint: "unavailable-source", schedulingAllowed: false }),
      resolveCredentialEnv: async () => ({ HOME: "/owner" }) });
    expect((await collect(adapter.start(input))).at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(nativeSessions.runTurn.mock.calls[0]![0].schedulingAllowed).toBe(false);
  });
  it.each(["credentials", "source"])("stops the exact held source on an early %s preparation failure", async stage => {
    const nativeSessions = pool();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions,
      resolveCredentialEnv: async () => { if (stage === "credentials") throw new Error("setup unavailable"); return { HOME: "/owner", ANTHROPIC_API_KEY: "key" }; },
      resolveSessionSource: async () => { throw new Error("source unavailable"); } });
    const due = { ...input, runId: "run_due", turnId: "cturn_due", resumeState: { sessionId: "session_a" },
      nativeScheduled: { sourceRunId: "run_a", sessionId: "session_a", promptId: "11111111-1111-4111-8111-111111111111" } };
    await collect(adapter.resume!(due)).catch(() => {});
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
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions,
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
    const adapter = createClaudeChatProviderAdapter({ homePath: "/owner", spawnFn, nativeSessions,
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
