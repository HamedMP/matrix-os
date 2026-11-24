import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentThreadEventSchema,
  CODEX_VERIFIED_VERSION,
  type AgentThreadEvent,
} from "../../packages/contracts/src/index.js";
import {
  CodingAgentThreadError,
  createCodingAgentThreadStore,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createCodexEventBridge } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };
const now = new Date("2026-07-13T11:00:00.000Z");

function event(threadId: string, overrides: Partial<AgentThreadEvent> = {}): AgentThreadEvent {
  return AgentThreadEventSchema.parse({
    type: "assistant.text.delta",
    eventId: "evt_provider_delta_1",
    threadId,
    occurredAt: now.toISOString(),
    messageId: "item_1",
    delta: "A structured provider response.",
    ...overrides,
  });
}

function provider(resumeTurn = vi.fn()): CodingAgentProviderAdapter {
  return {
    providerId: "codex",
    startThread({ thread, nextEventId }) {
      return {
        events: [AgentThreadEventSchema.parse({
          type: "thread.status",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now.toISOString(),
          status: "running",
        })],
        resumeState: { conversationId: `sess_${thread.id.slice("thread_".length)}` },
      };
    },
    resumeTurn,
  };
}

describe("coding-agent provider event ingestion", () => {
  it.each([false, true])("delivers a greeting with one durable checkpoint and opt-in diagnostics ($timings)", async timings => {
    vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", timings ? "1" : "0");
    const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-batch-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()] });
    const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) });
    try {
      const { snapshot } = await store.createThread(principal, { providerId: "codex", prompt: "hey", clientRequestId: "req_greeting" });
      const threadId = snapshot.thread.id;
      bridge.attachThreadStore(store);
      const { path } = await bridge.watch({ principal, threadId, sessionId: `sess_${threadId.slice(7)}`, checkpoint: true });
      const lines = [
        { type: "thread.started", thread_id: "native_greeting" },
        ...["Hey! ", "What would you like ", "to work on?"].map(delta => ({ type: "matrix.codex.assistant.delta", messageId: "msg_greeting", delta })),
        { type: "matrix.codex.assistant.completed", messageId: "msg_greeting" },
        { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } },
      ].map(line => JSON.stringify(line) + "\n").join("");
      await writeFile(path, lines);
      const ingest = vi.spyOn(store, "ingestProviderEvents");
      const published = vi.fn();
      store.registerEventSink(published);
      await bridge.drain();
      const reloaded = createCodingAgentThreadStore({ homePath, providers: [provider()] });
      const delivered = await reloaded.getThread(principal, threadId);
      expect(delivered.thread.status).toBe("completed");
      expect(delivered.events.items.filter(event => event.type === "assistant.text.delta").map(event => event.delta).join(""))
        .toBe("Hey! What would you like to work on?");
      expect(published.mock.calls.flatMap(([batch]) => batch.events).filter(event => event.type === "thread.completed")).toHaveLength(1);
      expect(published.mock.calls.at(-1)?.[0].tokenUsage).toEqual({ inputTokens: 20, outputTokens: 10 });
      expect(ingest).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(await readFile(join(homePath, "system/coding-agents/threads.json"), "utf8"));
      expect(saved.threads[0].providerEventOffset).toBe(Buffer.byteLength(lines));
      const traces = logs.mock.calls.filter(([prefix]) => prefix === "[chat-send-timing]").map(([, record]) => JSON.parse(String(record)));
      if (timings) {
        expect(traces.map(trace => trace.stage)).toEqual(expect.arrayContaining([
          "bridge_read", "bridge_ingest", "store_queue_wait", "store_read", "store_mutation", "store_write", "store_projection",
        ]));
        expect(new Set(traces.map(trace => trace.session)).size).toBe(1);
        expect(traces.every(trace => /^[a-f0-9]{20}$/.test(trace.session) && trace.durationMs >= 0)).toBe(true);
        expect(JSON.stringify(traces)).not.toMatch(/native_greeting|msg_greeting|Hey!|owner_user|req_greeting|\/tmp/);
      } else expect(traces).toEqual([]);
      // Replay the terminal batch as if its acknowledgement had been lost.
      // Already committed output and usage must not be published a second time.
      bridge.unwatch(`sess_${threadId.slice(7)}`);
      await bridge.watch({ principal, threadId, sessionId: `sess_${threadId.slice(7)}`, startOffset: 0, checkpoint: true });
      await bridge.drain();
      expect(published.mock.calls.filter(([batch]) => batch.tokenUsage)).toHaveLength(1);
      expect(published.mock.calls.flatMap(([batch]) => batch.events).filter(event => event.type === "assistant.text.delta")).toHaveLength(3);
    } finally {
      await bridge.shutdown(); await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true });
      logs.mockRestore(); vi.unstubAllEnvs();
    }
  });

  it("checkpoints a native record exceeding the event limit only after all its events are persisted", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-large-record-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()] });
    const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) });
    try {
      const { snapshot } = await store.createThread(principal, { providerId: "codex", prompt: "files", clientRequestId: "req_large_record" });
      const threadId = snapshot.thread.id;
      bridge.attachThreadStore(store);
      const { path } = await bridge.watch({ principal, threadId, sessionId: `sess_${threadId.slice(7)}`, checkpoint: true });
      const line = JSON.stringify({ type: "item.completed", item: { id: "files", type: "file_change", status: "completed",
        changes: Array.from({ length: 200 }, (_, index) => ({ path: `src/file-${index}.ts`, kind: "update" })) } }) + "\n";
      await writeFile(path, line);
      const ingest = vi.spyOn(store, "ingestProviderEvents");
      await bridge.drain();
      const saved = JSON.parse(await readFile(join(homePath, "system/coding-agents/threads.json"), "utf8"));
      expect(saved.events.filter(event => event.type === "file.changed").map(event => event.path))
        .toEqual(Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`));
      expect(ingest.mock.calls.map(([, , batch]) => batch.events.length)).toEqual([100, 100, 2]);
      expect(ingest.mock.calls.slice(0, 2).every(([, , , cursor]) => cursor?.checkpoint === false)).toBe(true);
      expect(saved.threads[0].providerEventOffset).toBe(Buffer.byteLength(line));
    } finally { await bridge.shutdown(); await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });

  it.each(["before_commit", "after_commit"])("does not replay an oversized committed record after its IDs leave retained history: %s", async failure => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-evicted-replay-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()] });
    const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) });
    const original = store.ingestProviderEvents.bind(store);
    let calls = 0;
    const ingest = vi.spyOn(store, "ingestProviderEvents").mockImplementation(async (...args) => {
      calls++;
      if (calls === 10 && failure === "before_commit") throw new Error("Injected later batch failure");
      const result = await original(...args);
      if (calls === 10 && failure === "after_commit") throw new Error("Injected later lost acknowledgement");
      return result;
    });
    const published = vi.fn();
    store.registerEventSink(published);
    try {
      const { snapshot } = await store.createThread(principal, { providerId: "codex", prompt: "files", clientRequestId: "req_evicted_replay" });
      const threadId = snapshot.thread.id;
      bridge.attachThreadStore(store);
      const { path } = await bridge.watch({ principal, threadId, sessionId: `sess_${threadId.slice(7)}`, checkpoint: true });
      const lines = [
        { type: "item.completed", item: { id: "files", type: "file_change", status: "completed",
          changes: Array.from({ length: 200 }, (_, index) => ({ path: `src/file-${index}.ts`, kind: "update" })) } },
        ...Array.from({ length: 650 }, (_, index) => ({ type: "matrix.codex.assistant.delta", messageId: "msg_later", delta: `part ${index} ` })),
        { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 15 } },
      ].map(line => JSON.stringify(line) + "\n").join("");
      await writeFile(path, lines);
      await bridge.drain();
      expect(calls).toBe(10);
      const statePath = join(homePath, "system/coding-agents/threads.json");
      const before = JSON.parse(await readFile(statePath, "utf8"));
      expect(before.events.some((event: AgentThreadEvent) => event.type === "file.changed")).toBe(false);
      const retainedIds = before.events.slice(-300).map((event: AgentThreadEvent) => event.eventId);
      const publicationCount = published.mock.calls.length;
      await bridge.drain();
      const replayed = published.mock.calls.slice(publicationCount).flatMap(([batch]) => batch.events);
      expect(replayed.filter(event => event.type === "file.changed")).toEqual([]);
      const after = JSON.parse(await readFile(statePath, "utf8"));
      expect(after.events.map((event: AgentThreadEvent) => event.eventId)).toEqual(expect.arrayContaining(retainedIds));
      expect(after.threads[0]).toMatchObject({ status: "completed", providerEventOffset: Buffer.byteLength(lines) });
      expect(published.mock.calls.filter(([batch]) => batch.tokenUsage)).toHaveLength(1);
    } finally {
      ingest.mockRestore();
      await bridge.shutdown(); await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true });
    }
  });

  it.each(["before_commit", "after_commit"])("bounds checkpoint batches and resumes exactly once after %s failure", async failure => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-batch-recovery-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()] });
    const options = { homePath, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) };
    const bridge = createCodexEventBridge(options);
    let restarted: ReturnType<typeof createCodexEventBridge> | undefined;
    try {
      const { snapshot } = await store.createThread(principal, { providerId: "codex", prompt: "reply", clientRequestId: "req_batch_recovery" });
      const threadId = snapshot.thread.id;
      const sessionId = `sess_${threadId.slice(7)}`;
      bridge.attachThreadStore(store);
      const { path } = await bridge.watch({ principal, threadId, sessionId, checkpoint: true });
      const text = Array.from({ length: 101 }, (_, index) => `part ${index} ☀ `);
      const prefix = [{ type: "thread.started", thread_id: "native_recovery" },
        ...text.slice(0, 99).map(delta => ({ type: "matrix.codex.assistant.delta", messageId: "msg_recovery", delta }))]
        .map(line => JSON.stringify(line) + "\n").join("");
      // One native line expands into two consumer events, across the 100-event batch boundary.
      const remainder = [
        { type: "item.completed", item: { id: "msg_extra", type: "agent_message", text: "extra " } },
        ...text.slice(99).map(delta => ({ type: "matrix.codex.assistant.delta", messageId: "msg_recovery", delta })),
        { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 15 } },
      ].map(line => JSON.stringify(line) + "\n").join("");
      const partial = '{"type":"ignored_future_event"';
      await writeFile(path, prefix + remainder + partial);
      const original = store.ingestProviderEvents.bind(store);
      let calls = 0;
      const ingest = vi.spyOn(store, "ingestProviderEvents").mockImplementation(async (...args) => {
        calls++;
        if (failure === "before_commit" && calls === 2) throw new Error("Injected persistence failure");
        const result = await original(...args);
        if (failure === "after_commit" && calls === 1) throw new Error("Injected lost acknowledgement");
        return result;
      });
      await bridge.drain();
      bridge.unwatch(sessionId);
      await bridge.shutdown();
      ingest.mockRestore();
      const statePath = join(homePath, "system/coding-agents/threads.json");
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      expect(saved.threads[0].providerEventOffset).toBe(Buffer.byteLength(prefix));
      const recovered = createCodingAgentThreadStore({ homePath, providers: [provider()] });
      restarted = createCodexEventBridge(options);
      restarted.attachThreadStore(recovered);
      await restarted.watch({ principal, threadId, sessionId, startOffset: saved.threads[0].providerEventOffset, checkpoint: true });
      const resumedIngest = vi.spyOn(recovered, "ingestProviderEvents");
      const published = vi.fn();
      recovered.registerEventSink(published);
      await restarted.drain();
      const delivered = await recovered.getThread(principal, threadId);
      expect(delivered.thread.status).toBe("completed");
      expect(delivered.events.items.filter(event => event.type === "assistant.text.delta").map(event => event.delta).join(""))
        .toBe(text.slice(0, 99).join("") + "extra " + text.slice(99).join(""));
      expect(resumedIngest).toHaveBeenCalledTimes(1);
      expect(resumedIngest.mock.calls.every(([, , batch]) => batch.events.length <= 100)).toBe(true);
      expect(published.mock.calls.filter(([batch]) => batch.tokenUsage)).toHaveLength(1);
      expect(JSON.parse(await readFile(statePath, "utf8")).threads[0].providerEventOffset).toBe(Buffer.byteLength(prefix + remainder));
      await appendFile(path, '}\n');
      await restarted.drain();
      expect(JSON.parse(await readFile(statePath, "utf8")).threads[0].providerEventOffset).toBe(Buffer.byteLength(prefix + remainder + partial + '}\n'));
      expect(published.mock.calls.filter(([batch]) => batch.tokenUsage)).toHaveLength(1);
    } finally { await restarted?.shutdown(); await bridge.shutdown(); await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });

  it("durably appends and publishes owner-scoped provider events before replay", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-ingestion-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()], now: () => now });
    const sink = vi.fn();
    store.registerEventSink(sink);
    try {
      const created = await store.createThread(principal, {
        providerId: "codex",
        prompt: "Inspect the tests.",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        clientRequestId: "req_provider_ingestion_1",
      });
      sink.mockClear();
      const providerEvent = event(created.snapshot.thread.id);

      await store.ingestProviderEvents(principal, created.snapshot.thread.id, {
        events: [providerEvent],
        providerThreadId: "019f-provider-thread-1",
      });

      expect(sink).toHaveBeenCalledWith({
        ownerId: principal.userId,
        threadId: created.snapshot.thread.id,
        events: [providerEvent],
      });
      expect((await store.getThread(principal, created.snapshot.thread.id)).events.items)
        .toContainEqual(providerEvent);
    } finally {
      await store.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("deduplicates replayed event ids and preserves provider resume identity", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-ingestion-"));
    const resumeTurn = vi.fn(async ({ resumeState }) => ({
      events: [],
      outcome: "completed" as const,
      resumeState,
    }));
    const store = createCodingAgentThreadStore({
      homePath,
      providers: [provider(resumeTurn)],
      relationValidator: {
        validateCreate: async () => undefined,
        validateThread: async () => undefined,
      },
      now: () => now,
    });
    try {
      const created = await store.createThread(principal, {
        providerId: "codex",
        prompt: "Inspect the tests.",
        projectId: "repo-main",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        clientRequestId: "req_provider_ingestion_2",
      });
      const providerEvent = event(created.snapshot.thread.id);
      const batch = { events: [providerEvent], providerThreadId: "019f-provider-thread-2" };

      await store.ingestProviderEvents(principal, created.snapshot.thread.id, batch);
      await store.ingestProviderEvents(principal, created.snapshot.thread.id, batch);
      const snapshot = await store.getThread(principal, created.snapshot.thread.id);
      expect(snapshot.events.items.filter((item) => item.eventId === providerEvent.eventId)).toHaveLength(1);

      await store.acceptTurn(principal, created.snapshot.thread.id, {
        message: "Continue.",
        clientRequestId: "req_provider_ingestion_turn_1",
      });
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalled());
      expect(resumeTurn).toHaveBeenCalledWith(expect.objectContaining({
        resumeState: {
          conversationId: expect.stringMatching(/^sess_/),
          providerThreadId: "019f-provider-thread-2",
        },
      }));
    } finally {
      await store.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("scopes replay deduplication to one thread", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-ingestion-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()], now: () => now });
    try {
      const first = await store.createThread(principal, {
        providerId: "codex",
        prompt: "Inspect the first thread.",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        clientRequestId: "req_provider_ingestion_scope_1",
      });
      const second = await store.createThread(principal, {
        providerId: "codex",
        prompt: "Inspect the second thread.",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        clientRequestId: "req_provider_ingestion_scope_2",
      });

      await store.ingestProviderEvents(principal, first.snapshot.thread.id, {
        events: [event(first.snapshot.thread.id)],
      });
      await store.ingestProviderEvents(principal, second.snapshot.thread.id, {
        events: [event(second.snapshot.thread.id)],
      });

      expect((await store.getThread(principal, first.snapshot.thread.id)).events.items)
        .toContainEqual(event(first.snapshot.thread.id));
      expect((await store.getThread(principal, second.snapshot.thread.id)).events.items)
        .toContainEqual(event(second.snapshot.thread.id));
    } finally {
      await store.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("rejects cross-owner, cross-thread, and reserved provider events", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-provider-ingestion-"));
    const store = createCodingAgentThreadStore({ homePath, providers: [provider()], now: () => now });
    try {
      const created = await store.createThread(principal, {
        providerId: "codex",
        prompt: "Inspect the tests.",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        clientRequestId: "req_provider_ingestion_3",
      });
      await expect(store.ingestProviderEvents(otherPrincipal, created.snapshot.thread.id, {
        events: [event(created.snapshot.thread.id)],
      })).rejects.toBeInstanceOf(CodingAgentThreadError);
      await expect(store.ingestProviderEvents(principal, created.snapshot.thread.id, {
        events: [event("thread_another")],
      })).rejects.toThrow("Provider emitted event for another thread");
      await expect(store.ingestProviderEvents(principal, created.snapshot.thread.id, {
        events: [AgentThreadEventSchema.parse({
          type: "thread.created",
          eventId: "evt_provider_reserved_1",
          threadId: created.snapshot.thread.id,
          occurredAt: now.toISOString(),
          thread: created.snapshot.thread,
        })],
      })).rejects.toThrow("Provider emitted reserved lifecycle event");
      await store.ingestProviderEvents(principal, created.snapshot.thread.id, {
        events: [],
        providerThreadId: "019f-provider-thread-original",
      });
      await expect(store.ingestProviderEvents(principal, created.snapshot.thread.id, {
        events: [],
        providerThreadId: "019f-provider-thread-replaced",
      })).rejects.toThrow("Provider conversation mismatch");
    } finally {
      await store.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
