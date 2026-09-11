import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSummary } from "../../packages/contracts/src/index.js";
import { createPiCodingAgentProvider, type PiSpawnFn } from "../../packages/gateway/src/coding-agents/pi-provider.js";

let homePath: string;
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "matrix-pi-steer-")); });
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

it.each([true, false])("keeps steered replies distinct with text_start=%s", async (hasTextStart) => {
  const published: AgentThreadEvent[] = [];
  let starts = 0;
  const spawnFn: PiSpawnFn = (_command, args) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const lifecycle = new EventEmitter();
    starts++;
    let attempt = 0;
    const replyFor = (attempt: number) => ["STEP1: initial read complete", "STEP2: redirected read complete", "STEER_OK ORBIT-228"][attempt]!;
    const respond = () => queueMicrotask(() => {
      const reply = replyFor(attempt);
      for (const event of [
        { type: "session", id: args[args.indexOf("--session-id") + 1] },
        { type: "message_start", message: { role: "assistant", content: [] } },
        ...(hasTextStart ? [{ type: "message_update", assistantMessageEvent: { type: "text_start" } }] : []),
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
      ]) stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
      if (attempt === 2) stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
      attempt++;
    });
    return {
      stdin: { write(line: string) { const frame = JSON.parse(line); if (frame.type === "prompt" || frame.type === "steer") respond(); return true; } },
      stdout,
      stderr,
      once: lifecycle.once.bind(lifecycle),
      kill: (signal) => { queueMicrotask(() => lifecycle.emit("exit", null, signal)); },
    };
  };
  const provider = createPiCodingAgentProvider({
    homePath,
    spawnFn,
    resolveProjectPath: async () => "/work/repo",
    killGraceMs: 5,
  });
  const now = () => new Date("2026-09-09T14:00:00.000Z");
  const thread: AgentThreadSummary = {
    id: "thread_019f8e9c1e8c7bedbd12eda826fd07",
    providerId: "pi",
    title: "Steer regression",
    status: "running",
    attention: "none",
    projectId: "repo-main",
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  let eventCounter = 0;
  const principal = { userId: "owner_user", source: "jwt" as const };
  const resultPromise = provider.startThread({
    principal,
    thread,
    request: {
      providerId: "pi", prompt: "Read and remember ORBIT-228", projectId: "repo-main",
      clientRequestId: "req_pi_1", sandboxMode: "read_only",
    },
    now,
    nextEventId: () => `evt_${++eventCounter}_pi_steer`,
    publishEvents: async (batch) => { published.push(...batch.events); },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await vi.waitFor(() => expect(published.filter((event) => event.type === "assistant.text.completed")).toHaveLength(attempt + 1));
    await provider.steerTurn!({
      principal, thread, message: attempt === 0 ? "Read the next block" : "Reply STEER_OK and the marker",
      clientRequestId: `req_pi_steer_${attempt}`,
    });
  }
  await resultPromise;
  expect(starts).toBe(1);
  const completed = published.filter((event) => event.type === "assistant.text.completed");
  expect(completed).toHaveLength(3);
  expect(new Set(completed.map((event) => event.messageId)).size).toBe(3);
  const final = published.filter((event) => event.type === "assistant.text.delta" && event.messageId === completed[2]!.messageId);
  expect(final.map((event) => event.delta).join("")).toBe("STEER_OK ORBIT-228");
});
