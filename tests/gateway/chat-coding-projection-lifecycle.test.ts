import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";
import { createChatFailureRecorder } from "../../packages/gateway/src/chat/failure-telemetry.js";
import { catalog, owner, principal } from "./helpers/canonical-codex-catalog.js";

describe("Chat projection preserves the backing execution lifecycle", () => {
  it("rejects retry before admission when a historically failed Chat still has active backing work", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-projection-retry-"));
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    const finish = Promise.withResolvers<void>();
    const finishRetry = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    let starts = 0;
    const threads = createCodingAgentThreadStore({ homePath, providers: [{
      providerId: "codex", initialRunExecution: "background",
      async startThread({ thread, signal, nextEventId, now, publishEvents }) {
        starts += 1;
        nativeSignal = signal;
        const base = () => ({ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString() });
        await publishEvents!({ events: [{ ...base(), type: "thread.status", status: "running" },
          { ...base(), type: "assistant.text.delta", messageId: "msg_active", delta: "Working" }] });
        await (starts === 1 ? finish.promise : finishRetry.promise);
        return { events: [{ ...base(), type: "thread.completed", outcome: "completed" }] };
      },
    }] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]) });
    try {
      await repository.create(owner, { id: "chat_projection", clientRequestId: "req_create_projection", title: "Projection" });
      const admission = await orchestrator.admitTurn(principal, owner, "chat_projection", {
        clientRequestId: "req_projection", baseRevision: 0,
        parts: [{ type: "text", text: "Inspect runtime" }], selection: { instanceId: "codex_default", model: "model" },
        interactionMode: "default", permissionMode: "supervised",
      });
      await vi.waitFor(async () => expect((await repository.exportChat(owner, "chat_projection"))?.messages.length).toBe(2));
      // Persist the historical mismatch without mocking admission, dispatch, or state reads.
      await repository.finishRun(owner, { chatId: "chat_projection", runId: admission.run.id,
        outcome: "failed", completedAt: new Date().toISOString() });
      await expect(orchestrator.retryTurn(principal, owner, "chat_projection", admission.turn.id, {
        clientRequestId: "req_retry_projection", baseRevision: (await repository.get(owner, "chat_projection"))!.chat.revision,
      })).rejects.toMatchObject({ status: 409 });
      expect((await repository.exportChat(owner, "chat_projection"))?.runs).toHaveLength(1);
      expect(starts).toBe(1);
      expect(nativeSignal?.aborted).toBe(false);
      finish.resolve();
      await orchestrator.drain();
      const retryInput = {
        clientRequestId: "req_retry_settled", baseRevision: (await repository.get(owner, "chat_projection"))!.chat.revision,
      };
      const retry = await orchestrator.retryTurn(principal, owner, "chat_projection", admission.turn.id, retryInput);
      await vi.waitFor(async () => expect((await repository.exportChat(owner, "chat_projection"))?.messages.length).toBe(3));
      const replay = await orchestrator.retryTurn(principal, owner, "chat_projection", admission.turn.id, retryInput);
      expect(replay.run.id).toBe(retry.run.id);
      await repository.finishRun(owner, { chatId: "chat_projection", runId: retry.run.id,
        outcome: "failed", completedAt: new Date().toISOString() });
      const terminalReplay = await orchestrator.retryTurn(principal, owner, "chat_projection", admission.turn.id, retryInput);
      expect(terminalReplay.run.id).toBe(retry.run.id);
      expect(nativeSignal?.aborted).toBe(false);
      finishRetry.resolve();
      await orchestrator.drain();
      expect(starts).toBe(2);
      expect((await repository.exportChat(owner, "chat_projection"))?.runs.map((run) => run.status))
        .toEqual(["failed", "failed"]);
    } finally {
      finish.resolve();
      finishRetry.resolve();
      await orchestrator.drain();
      await orchestrator.close();
      await threads.shutdownTurns();
      await repository.kysely.destroy();
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it.each(["none", "once", "always"] as const)("keeps unconfirmed cleanup busy (state write failure=%s)", async (stateFailure) => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-unconfirmed-stop-"));
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    const capture = vi.fn();
    const telemetry = createCanonicalChatEventStream({ repository, onCommittedEvent: createChatFailureRecorder({ capture }) });
    const persistState = repository.updateAdapterState.bind(repository);
    let stateWrites = 0;
    const stateWrite = vi.spyOn(repository, "updateAdapterState").mockImplementation(async (...args) => {
      stateWrites += 1;
      if (stateFailure === "always" || (stateFailure === "once" && stateWrites === 1)) throw new Error("Storage unavailable");
      return persistState(...args);
    });
    const finish = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    let nativeThreadId = "";
    const threads = createCodingAgentThreadStore({ homePath, providers: [{
      providerId: "codex", initialRunExecution: "background",
      async startThread({ thread, signal, nextEventId, now, publishEvents }) {
        nativeSignal = signal;
        nativeThreadId = thread.id;
        const base = () => ({ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString() });
        await publishEvents!({ events: [{ ...base(), type: "thread.status", status: "running" }] });
        for (let i = 0; i < 26; i += 1) {
          await publishEvents!({ events: [{ ...base(), type: "assistant.text.delta", messageId: "msg_large", delta: "x".repeat(4_000) }] });
        }
        await finish.promise;
        return { events: [{ ...base(), type: "thread.completed", outcome: "completed" }] };
      },
      async abortThread() { throw new Error("control socket unavailable token=private-stop"); },
    }] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]) });
    try {
      await repository.create(owner, { id: "chat_projection", clientRequestId: "req_create_projection", title: "Projection" });
      const admission = await orchestrator.admitTurn(principal, owner, "chat_projection", {
        clientRequestId: "req_projection", baseRevision: 0,
        parts: [{ type: "text", text: "Inspect runtime" }], selection: { instanceId: "codex_default", model: "model" },
        interactionMode: "default", permissionMode: "supervised",
      });
      await orchestrator.drain();
      expect((await threads.getThread(principal, nativeThreadId)).thread.status).toBe("running");
      expect(nativeSignal?.aborted).toBe(false);
      expect((await repository.exportChat(owner, "chat_projection"))?.runs[0]?.status).toBe("running");
      await expect(orchestrator.retryTurn(principal, owner, "chat_projection", admission.turn.id, {
        clientRequestId: "req_retry_unconfirmed", baseRevision: (await repository.get(owner, "chat_projection"))!.chat.revision,
      })).rejects.toMatchObject({ status: 409 });
      const snapshot = await repository.exportChat(owner, "chat_projection");
      expect(snapshot?.runs).toHaveLength(1);
      expect(snapshot?.runs[0]?.status).toBe("running");
      expect(JSON.stringify(snapshot)).not.toContain("private-stop");
      expect(capture.mock.calls.filter(([event]) => event === "matrix_agent_run_failed")).toHaveLength(0);
      expect(capture).toHaveBeenCalledWith("matrix_agent_run_sync_failed", expect.objectContaining({ properties: expect.objectContaining({
        chat_id: "chat_projection", failure_kind: "synchronization", failure_stage: "cleanup", run_status: "running",
      }) }));
      finish.resolve();
      await vi.waitFor(async () => expect((await threads.getThread(principal, nativeThreadId)).thread.status).toBe("completed"));
      await orchestrator.reconcileActiveRuns(owner);
      expect((await repository.exportChat(owner, "chat_projection"))?.runs[0]?.status).toBe(stateFailure === "always" ? "running" : "failed");
      if (stateFailure !== "always") expect(capture).toHaveBeenLastCalledWith("matrix_agent_run_failed", expect.objectContaining({
        properties: expect.objectContaining({ failure_kind: "synchronization", failure_stage: "recovery" }),
      }));
    } finally {
      stateWrite.mockRestore();
      telemetry.shutdown();
      finish.resolve();
      if (nativeThreadId) await vi.waitFor(async () => expect((await threads.getThread(principal, nativeThreadId)).thread.status).toBe("completed"));
      await orchestrator.close();
      await threads.shutdownTurns();
      await repository.kysely.destroy();
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it("stops accepted backing work before committing a projection failure", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-projection-stop-"));
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    const capture = vi.fn();
    const telemetry = createCanonicalChatEventStream({ repository, onCommittedEvent: createChatFailureRecorder({ capture }) });
    const finish = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    let statusAtStop: string | undefined;
    let nativeThreadId = "";
    const threads = createCodingAgentThreadStore({ homePath, providers: [{
      providerId: "codex", initialRunExecution: "background",
      async startThread({ thread, signal, nextEventId, now, publishEvents }) {
        nativeSignal = signal;
        nativeThreadId = thread.id;
        for (let i = 0; i < 26; i += 1) {
          await publishEvents!({ events: [{ threadId: thread.id, eventId: nextEventId(),
            occurredAt: now().toISOString(), type: "assistant.text.delta", messageId: "msg_large", delta: "x".repeat(4_000) }] });
        }
        await finish.promise;
        return { events: [] };
      },
      async abortThread({ thread, nextEventId, now }) {
        statusAtStop = (await repository.exportChat(owner, "chat_projection"))?.runs[0]?.status;
        finish.resolve();
        return [{ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(),
          type: "thread.completed", outcome: "aborted" }];
      },
    }] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]) });
    try {
      await repository.create(owner, { id: "chat_projection", clientRequestId: "req_create_projection", title: "Projection" });
      await orchestrator.admitTurn(principal, owner, "chat_projection", {
        clientRequestId: "req_projection", baseRevision: 0,
        parts: [{ type: "text", text: "Inspect runtime" }], selection: { instanceId: "codex_default", model: "model" },
        interactionMode: "default", permissionMode: "supervised",
      });
      await orchestrator.drain();
      expect((await repository.exportChat(owner, "chat_projection"))?.runs[0]?.status).toBe("failed");
      expect(nativeSignal?.aborted).toBe(true);
      expect(statusAtStop).toBe("running");
      expect((await threads.getThread(principal, nativeThreadId)).thread.status).toBe("aborted");
      expect(capture).toHaveBeenCalledWith("matrix_agent_run_failed", expect.objectContaining({ properties: expect.objectContaining({
        chat_id: "chat_projection", failure_kind: "projection", failure_stage: "projection", error_category: "resource_limit",
      }) }));
    } finally {
      finish.resolve();
      await orchestrator.close();
      telemetry.shutdown();
      await threads.shutdownTurns();
      await repository.kysely.destroy();
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it.each(["completed", "failed", "aborted"] as const)("waits for the actual %s terminal event", async (outcome) => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-projection-lifecycle-"));
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    const finish = Promise.withResolvers<void>();
    let starts = 0;
    let nativeThreadId = "";
    let nativeSignal: AbortSignal | undefined;
    const threads = createCodingAgentThreadStore({ homePath, providers: [{
      providerId: "codex", initialRunExecution: "background",
      async startThread({ thread, signal, nextEventId, now, publishEvents }) {
        starts += 1;
        nativeThreadId = thread.id;
        nativeSignal = signal;
        const base = () => ({ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString() });
        await publishEvents!({ events: [
          { ...base(), type: "thread.status", status: "running" },
          { ...base(), type: "tool.started", toolCallId: "tool_command", kind: "command",
            displayName: "Run command", preview: "ls /opt/matrix/app", previewKind: "command",
            detail: "Working directory: /root/private" },
          { ...base(), type: "tool.completed", toolCallId: "tool_command", outcome: "success" },
          { ...base(), type: "assistant.text.delta", messageId: "msg_result", delta: "Still working. " },
        ] });
        await finish.promise;
        return { events: [
          { ...base(), type: "assistant.text.delta" as const, messageId: "msg_result", delta: "Final answer." },
          { ...base(), type: "thread.completed" as const, outcome },
        ], resumeState: { conversationId: "native_projection" } };
      },
    }] });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]) });
    try {
      await repository.create(owner, { id: "chat_projection", clientRequestId: "req_create_projection", title: "Projection" });
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_projection", {
        clientRequestId: "req_projection", baseRevision: 0,
        parts: [{ type: "text", text: "Inspect runtime" }],
        selection: { instanceId: "codex_default", model: "model" },
        interactionMode: "default", permissionMode: "supervised",
      });
      await vi.waitFor(async () => {
        const snapshot = await repository.exportChat(owner, "chat_projection");
        expect(snapshot?.messages.some((message) => message.parts.some((part) =>
          part.type === "text" && part.text === "Still working. "))).toBe(true);
      }, { timeout: 5_000 });
      const active = await repository.exportChat(owner, "chat_projection");
      expect(active?.runs.map((run) => run.status)).toEqual(["running"]);
      expect(nativeSignal?.aborted).toBe(false);
      expect((await threads.getThread(principal, nativeThreadId)).thread.status).toBe("running");
      await expect(orchestrator.retryTurn(principal, owner, "chat_projection", admitted.turn.id, {
        clientRequestId: "req_retry_active", baseRevision: (await repository.get(owner, "chat_projection"))!.chat.revision,
      })).rejects.toMatchObject({ status: 409 });
      expect(starts).toBe(1);
      finish.resolve();
      await orchestrator.drain();
      const completed = await repository.exportChat(owner, "chat_projection");
      expect(completed?.runs.map((run) => run.status)).toEqual([outcome]);
      expect(completed?.messages.some((message) => message.parts.some((part) =>
        part.type === "text" && part.text === "Still working. Final answer."))).toBe(true);
      expect(completed?.activities.filter((activity) => activity.type === "agent.activity"))
        .toEqual([expect.objectContaining({ activityId: "tool_command", status: "completed", label: "Run command" })]);
      expect(JSON.stringify(completed)).not.toContain("/opt/matrix/app");
      expect(JSON.stringify(completed)).not.toContain("/root/private");
      expect(starts).toBe(1);
    } finally {
      finish.resolve();
      await orchestrator.drain();
      await orchestrator.close();
      await threads.shutdownTurns();
      await repository.kysely.destroy();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
