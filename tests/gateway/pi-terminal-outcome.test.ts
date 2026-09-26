import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentThreadSummary } from "../../packages/contracts/src/index.js";
import { createPiCodingAgentProvider, type PiSpawnFn } from "../../packages/gateway/src/coding-agents/pi-provider.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";
import { parseCodingAgentProviderRunResult } from "../../packages/gateway/src/coding-agents/provider-adapter.js";

// Pi v0.84.4 agent-loop.ts emits terminal error/aborted assistant messages,
// followed by agent_end. agent-session.ts emits agent_settled even on failure.
const rawError = "401 invalid token sk_test_privatefixture /home/owner/.pi/agent/auth.json";
const assistant = (stopReason: string, text = "") => ({
  role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [],
  ...(stopReason === "error" ? { errorMessage: rawError } : {}),
});
const messageEvents = (message: ReturnType<typeof assistant>) => [
  { type: "message_start", message: { role: "assistant", content: [] } },
  ...(message.content.length ? [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: message.content[0]!.text } }] : []),
  { type: "message_end", message },
  { type: "turn_end", message, toolResults: [] },
  { type: "agent_end", messages: [message], willRetry: false },
];
let homePath: string;
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "matrix-pi-outcome-")); });
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

function providerForFrames(frames: unknown[], settled = true, unterminatedTail = false) {
  const spawnFn: PiSpawnFn = () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter();
    let exited = false;
    const exit = () => { if (!exited) { exited = true; proc.emit("exit", 0, null); } };
    const child = Object.assign(proc, {
      stdout, stderr, stdin: { write: () => true },
      kill: () => { queueMicrotask(exit); return true; },
    });
    queueMicrotask(() => {
      const all = settled ? [...frames, { type: "agent_settled" }] : frames;
      stdout.emit("data", Buffer.from(all.map(frame => JSON.stringify(frame)).join("\n") + (unterminatedTail ? "" : "\n")));
      exit();
    });
    return child;
  };
  return createPiCodingAgentProvider({ homePath, spawnFn, killGraceMs: 5 });
}

async function run(frames: unknown[], settled = true, unterminatedTail = false) {
  const provider = providerForFrames(frames, settled, unterminatedTail);
  const now = new Date("2026-09-26T19:41:16.827Z");
  const thread: AgentThreadSummary = {
    id: "thread_pi_terminal_1", providerId: "pi", title: "Run", status: "queued",
    attention: "none", createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  let sequence = 0;
  return parseCodingAgentProviderRunResult(await provider.startThread({
    principal: { userId: "owner_test", source: "jwt" }, thread,
    request: { providerId: "pi", prompt: "Reply", clientRequestId: "req_pi_terminal", sandboxMode: "read_only" },
    now: () => now, nextEventId: () => `evt_pi_terminal_${++sequence}`,
  }), thread.id);
}

describe("Pi native terminal outcomes", () => {
  it("projects a real Pi terminal failure through the thread store into canonical Chat", async () => {
    const threads = createCodingAgentThreadStore({ homePath, providers: [providerForFrames(messageEvents(assistant("error")))] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "pi", threads });
    const events: CanonicalProviderRunEvent[] = [];
    try {
      for await (const event of adapter.start({
        owner: { type: "personal", ownerId: "owner_test" }, chatId: "chat_pi_failure", turnId: "cturn_pi_failure",
        runId: "run_pi_failure", prompt: "Reply", parts: [{ type: "text", text: "Reply" }],
        selection: { instanceId: "pi_default", model: "openai-codex/gpt-5.3-codex-spark" },
        interactionMode: "default", permissionMode: "supervised", signal: AbortSignal.timeout(5_000),
      })) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", outcome: "failed", error: expect.objectContaining({ code: "run_failed", safeMessage: "The coding Provider Run failed." }) }));
      expect(events.some(event => event.type === "run.completed" && event.outcome === "completed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain(rawError);
      expect(events.some(event => event.type === "assistant.delta")).toBe(false);
    } finally { await threads.shutdownTurns(); }
  });
  it.each([true, false])("reports terminal assistant error instead of success (agent_settled=%s)", async (settled) => {
    const result = await run(messageEvents(assistant("error")), settled);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
    expect(result.events.some(event => event.type === "thread.error")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(rawError);
    expect(JSON.stringify(result)).not.toContain("sk_test_privatefixture");
  });

  it("recognizes an error in a final JSON line without a newline before exit0", async () => {
    const result = await run([{ type: "turn_end", message: assistant("error"), toolResults: [] }], false, true);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
  });

  it("uses the last assistant outcome from agent_end when detailed frames are omitted", async () => {
    const result = await run([{ type: "agent_end", messages: [assistant("error"), { role: "toolResult", content: [] }], willRetry: false }]);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
  });

  it("does not erase a terminal error with malformed or legacy outcome frames", async () => {
    const result = await run([
      ...messageEvents(assistant("error")),
      { type: "message_end", message: null },
      { type: "turn_end", message: { role: "assistant", content: [] } },
      { type: "auto_retry_end", success: "true" },
    ]);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
  });

  it("reports native assistant abort as aborted", async () => {
    const result = await run(messageEvents(assistant("aborted")));
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "aborted" });
  });

  it("reports final unsuccessful retry even when its assistant message is omitted", async () => {
    const result = await run([{ type: "auto_retry_end", success: false, attempt: 3, finalError: rawError }]);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "failed" });
    expect(JSON.stringify(result)).not.toContain(rawError);
  });

  it("allows retry recovery after an intermediate assistant error", async () => {
    const result = await run([
      ...messageEvents(assistant("error")),
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: rawError },
      ...messageEvents(assistant("stop", "recovered")),
      { type: "auto_retry_end", success: true, attempt: 1 },
    ]);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "completed" });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "assistant.text.delta", delta: "recovered" }));
    expect(result.events.some(event => event.type === "thread.error")).toBe(false);
  });

  it.each(["stop", "toolUse", "length"])("preserves legitimate empty completion (%s)", async (reason) => {
    const result = await run(messageEvents(assistant(reason)));
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "completed" });
  });

  it("preserves legacy lifecycle-only completion", async () => {
    const result = await run([{ type: "agent_end", messages: [], willRetry: false }]);
    expect(result.events.at(-1)).toMatchObject({ type: "thread.completed", outcome: "completed" });
  });
});
