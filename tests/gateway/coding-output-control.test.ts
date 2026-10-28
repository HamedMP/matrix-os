import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentThreadEvent, AgentThreadSummary } from "@matrix-os/contracts";
import { createPiCodingAgentProvider } from "../../packages/gateway/src/coding-agents/pi-provider.js";
import { createOpenCodeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/opencode-provider.js";

vi.mock("../../packages/gateway/src/coding-agents/coding-preview-publisher.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/coding-agents/coding-preview-publisher.js")>();
  return { ...actual, createCodingPreviewPublisher: (publish: Parameters<typeof actual.createCodingPreviewPublisher>[0], _limit?: number, options?: Parameters<typeof actual.createCodingPreviewPublisher>[2]) => actual.createCodingPreviewPublisher(publish, 2, options) };
});

let homePath: string;
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "coding-output-control-")); });
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

function fixture(kind: "pi" | "opencode", blockType: "assistant.text.delta" | "user_input.requested", publish = true) {
  const frames: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: (value: string) => { frames.push(JSON.parse(value)); return true; } },
    kill: vi.fn(() => { queueMicrotask(() => child.emit("exit", null)); }),
  });
  const spawn = vi.fn(() => child);
  const options = { homePath, spawnFn: spawn, resolveProjectPath: async () => "/work/repo", resolveCredentialLaunch: async () => ({ env: {} }) };
  const provider = kind === "pi" ? createPiCodingAgentProvider(options) : createOpenCodeCodingAgentProvider(options);
  const principal = { userId: "owner_output", source: "jwt" as const };
  const now = () => new Date();
  const thread: AgentThreadSummary = { id: "thread_output_control", providerId: kind, title: "Output", status: "running", attention: "none", projectId: "repo", createdAt: now().toISOString(), updatedAt: now().toISOString() };
  let sequence = 0;
  const nextEventId = () => `evt_control_${++sequence}`;
  let release: () => void = () => undefined;
  let blocked = false;
  const published: AgentThreadEvent[] = [];
  const pending = Promise.resolve(provider.startThread({ principal, thread,
    request: { providerId: kind, projectId: "repo", prompt: "Continue", sandboxMode: "read_only", clientRequestId: "req_output" }, now, nextEventId,
    publishEvents: publish ? async batch => {
      published.push(...batch.events);
      if (!blocked && batch.events.some(event => event.type === blockType)) {
        blocked = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
    } : undefined,
  }));
  const emit = (value: unknown) => child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  const text = () => kind === "pi"
    ? emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } })
    : emit({ type: "text", sessionID: "ses_output", part: { id: "part_output", type: "text", text: "x" } });
  const complete = () => { if (kind === "pi") emit({ type: "agent_settled" }); else { child.stdout.emit("end"); child.emit("exit", 0); } };
  return { child, provider, principal, thread, now, nextEventId, spawn, pending, published, frames, emit, text, complete, release: () => release(), blocked: () => blocked };
}

it("delivers a real Pi input expiry through a preview queue full of ordinary output", async () => {
  const run = fixture("pi", "user_input.requested");
  try {
    await vi.waitFor(() => expect(run.spawn).toHaveBeenCalled());
    run.emit({ type: "extension_ui_request", id: "native_expiry", method: "input", title: "Answer", timeout: 150 });
    await vi.waitFor(() => expect(run.blocked()).toBe(true));
    run.text(); run.text(); run.text();
    await vi.waitFor(() => expect(run.frames).toContainEqual({ type: "extension_ui_response", id: "native_expiry", cancelled: true }));
    run.release();
    run.complete();
    const result = await run.pending;
    expect(run.published).toContainEqual(expect.objectContaining({ type: "user_input.answered", reason: "expired" }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "completed" }));
  } finally { run.release(); run.complete(); await run.pending; }
});

it.each(["pi", "opencode"] as const)("keeps Stop effective while completed %s output publication is still pending", async kind => {
  const run = fixture(kind, "assistant.text.delta");
  try {
    await vi.waitFor(() => expect(run.spawn).toHaveBeenCalled());
    run.text();
    await vi.waitFor(() => expect(run.blocked()).toBe(true));
    run.complete();
    await run.provider.abortThread({ principal: run.principal, thread: run.thread, now: run.now, nextEventId: run.nextEventId });
    const result = await run.pending;
    expect(result.events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "aborted" }));
  } finally { run.release(); run.complete(); await run.pending; }
}, 1_000);


it.each(["pi", "opencode"] as const)("contains %s final UTF-8 decoder overflow within the failed run", async kind => {
  const run = fixture(kind, "assistant.text.delta", false);
  await vi.waitFor(() => expect(run.spawn).toHaveBeenCalled());
  const cap = (kind === "pi" ? 8 : 1) * 1024 * 1024;
  run.child.stdout.emit("data", Buffer.concat([Buffer.alloc(cap, 0x20), Buffer.from([0xe2])]));
  try {
    expect(() => { run.child.stdout.emit("end"); run.child.emit("exit", 0); }).not.toThrow();
  } catch (error: unknown) {
    await run.provider.abortThread({ principal: run.principal, thread: run.thread, now: run.now, nextEventId: run.nextEventId });
    await run.pending;
    throw error;
  }
  const result = await run.pending;
  expect(result.events).toContainEqual(expect.objectContaining({ type: "thread.completed", outcome: "failed" }));
});

it("marks omitted OpenCode preview text when a final input control displaces it", async () => {
  const run = fixture("opencode", "assistant.text.delta", false);
  await vi.waitFor(() => expect(run.spawn).toHaveBeenCalled());
  for (let i = 0; i < 240; i++) {
    run.emit({ type: "text", part: { id: `part_${i}`, type: "text", text: "retained output" } });
  }
  run.emit({ type: "matrix.input.resolved", requestId: "req_full", correlationId: "corr_full", reason: "answered" });
  run.complete();
  const result = await run.pending;
  expect(result.events).toContainEqual(expect.objectContaining({ type: "user_input.answered", requestId: "req_full" }));
  expect(result.events).toContainEqual(expect.objectContaining({ type: "assistant.text.delta", delta: "Some output was omitted from this preview." }));
});
