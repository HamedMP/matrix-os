import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import { owner, principal } from "./helpers/canonical-codex-catalog.js";

const input = { owner, chatId: "chat_stop", turnId: "cturn_stop", runId: "run_stop",
  prompt: "Inspect", parts: [{ type: "text" as const, text: "Inspect" }],
  selection: { instanceId: "codex_default", model: "model" }, interactionMode: "default", permissionMode: "supervised" };

describe("Codex projection shutdown ownership", () => {
  it.each([["initial", false], ["resumed", false], ["initial", true]] as const)("fences a stale %s consumer after a newer turn (completed=%s)", async (kind, completed) => {
    const homePath = await mkdtemp(join(tmpdir(), "coding-stale-cleanup-"));
    let aborts = 0;
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex",
      async startThread({ thread, nextEventId, now }) {
        return { resumeState: { conversationId: "native_start" }, events: [{ threadId: thread.id, eventId: nextEventId(),
          occurredAt: now().toISOString(), type: "thread.status", status: kind === "initial" ? "running" : "completed" }] };
      },
      async resumeTurn() { return { events: [], outcome: "delivered" }; },
      async abortThread({ thread, nextEventId, now }) {
        aborts += 1;
        return [{ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(),
          type: "thread.completed", outcome: "aborted" }];
      },
    }] });
    let iterator: AsyncIterator<unknown> | undefined;
    try {
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
      let threadId: string;
      if (kind === "initial") {
        iterator = adapter.start({ ...input, signal: new AbortController().signal })[Symbol.asyncIterator]();
        const event = await iterator.next();
        threadId = (event.value as { state: { conversationId: string } }).state.conversationId;
      } else {
        const created = await threads.createThread(principal, { providerId: "codex", prompt: "Initial", clientRequestId: "req_initial" });
        threadId = created.snapshot.thread.id;
        iterator = adapter.resume!({ ...input, signal: new AbortController().signal,
          resumeState: adapter.parseState({ conversationId: threadId }) })[Symbol.asyncIterator]();
        await iterator.next();
        await vi.waitFor(async () => expect((await threads.getThread(principal, threadId)).events.items
          .some((event) => event.type === "turn.status" && event.status === "completed")).toBe(true));
      }
      await threads.ingestProviderEvents(principal, threadId, { events: [{ threadId, eventId: "evt_a_completed",
        occurredAt: new Date().toISOString(), type: "thread.completed", outcome: "completed" }] });
      const next = await threads.acceptTurn(principal, threadId, { message: "Newer work", clientRequestId: "req_newer" });
      await vi.waitFor(async () => expect((await threads.getThread(principal, threadId)).events.items
        .some((event) => event.type === "turn.status" && event.turnId === next.turnId && event.status === "completed")).toBe(true));
      if (completed) await threads.ingestProviderEvents(principal, threadId, { events: [{ threadId, eventId: "evt_b_completed",
        occurredAt: new Date().toISOString(), type: "thread.completed", outcome: "completed" }] });
      await iterator.return!();
      iterator = undefined;
      expect(aborts).toBe(0);
      expect((await threads.getThread(principal, threadId)).thread.status).toBe(completed ? "completed" : "running");
    } finally {
      await iterator?.return?.();
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it.each(["missing", "empty", "invalid"] as const)("does not invent terminal state for %s stop confirmation", async (confirmation) => {
    const homePath = await mkdtemp(join(tmpdir(), "coding-stop-confirmation-"));
    const provider: CodingAgentProviderAdapter = { providerId: "codex",
      async startThread({ thread, nextEventId, now }) {
        return { resumeState: { conversationId: "native_start" }, events: [{ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(),
          type: "thread.status", status: "running" }] };
      },
      async resumeTurn() { return { events: [], outcome: "delivered" }; },
      ...(confirmation === "missing" ? {} : { abortThread: async ({ thread, nextEventId, now }) => confirmation === "empty" ? [] : [
        { threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(), type: "thread.completed" as const,
          outcome: "completed" as const },
      ] } satisfies Pick<CodingAgentProviderAdapter, "abortThread">),
    };
    const threads = createCodingAgentThreadStore({ homePath, providers: [provider] });
    try {
      // Another thread's turn history must not fence this initial execution.
      const other = await threads.createThread(principal, { providerId: "codex", prompt: "Other", clientRequestId: "req_other" });
      await threads.ingestProviderEvents(principal, other.snapshot.thread.id, { events: [{ threadId: other.snapshot.thread.id,
        eventId: "evt_other_done", occurredAt: new Date().toISOString(), type: "thread.completed", outcome: "completed" }] });
      await threads.acceptTurn(principal, other.snapshot.thread.id, { message: "Other turn", clientRequestId: "req_other_turn" });
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
      const unconfirmed = vi.fn();
      const iterator = adapter.start({ ...input, signal: new AbortController().signal,
        onCleanupUnconfirmed: unconfirmed })[Symbol.asyncIterator]();
      const first = await iterator.next();
      const threadId = (first.value as { state: { conversationId: string } }).state.conversationId;
      await expect(iterator.return!()).rejects.toThrow();
      expect(unconfirmed).toHaveBeenCalledOnce();
      expect((await threads.getThread(principal, threadId)).thread.status).toBe("running");
    } finally {
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it("cancels an admitted resumed turn when its consumer exits early", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "coding-resume-stop-"));
    const finish = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    let aborted = 0;
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex",
      async startThread({ thread, nextEventId, now }) {
        return { resumeState: { conversationId: "native_start" }, events: [{ threadId: thread.id, eventId: nextEventId(),
          occurredAt: now().toISOString(), type: "thread.completed", outcome: "completed" }] };
      },
      async resumeTurn({ thread, signal, nextEventId, now, publishEvents }) {
        nativeSignal = signal;
        await publishEvents!({ events: [{ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(),
          type: "assistant.text.delta", messageId: "msg_resume", delta: "Resumed" }] });
        await finish.promise;
        return { events: [], outcome: "aborted" };
      },
      async abortThread({ thread, nextEventId, now }) {
        aborted += 1;
        finish.resolve();
        return [{ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(),
          type: "thread.completed", outcome: "aborted" }];
      },
    }] });
    try {
      const created = await threads.createThread(principal, { providerId: "codex", prompt: "Inspect", clientRequestId: "req_initial" });
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
      for await (const event of adapter.resume!({ ...input, signal: new AbortController().signal,
        resumeState: adapter.parseState({ conversationId: created.snapshot.thread.id }) })) {
        if (event.type === "assistant.delta") break;
      }
      expect(nativeSignal?.aborted).toBe(true);
      expect(aborted).toBe(1);
      expect((await threads.getThread(principal, created.snapshot.thread.id)).thread.status).toBe("aborted");
    } finally {
      finish.resolve();
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("does not cancel existing work when resume admission itself is rejected", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "coding-rejected-resume-"));
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex", initialRunExecution: "background",
      async startThread({ signal }) {
        nativeSignal = signal;
        started.resolve();
        await finish.promise;
        return { events: [] };
      },
    }] });
    try {
      const created = await threads.createThread(principal, { providerId: "codex", prompt: "Inspect", clientRequestId: "req_initial" });
      await started.promise;
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
      const consume = async () => {
        for await (const event of adapter.resume!({ ...input, signal: new AbortController().signal,
          resumeState: adapter.parseState({ conversationId: created.snapshot.thread.id }) })) {
          expect(event.type).not.toBe("run.completed");
        }
      };
      await expect(consume()).rejects.toThrow();
      expect(nativeSignal?.aborted).toBe(false);
      expect((await threads.getThread(principal, created.snapshot.thread.id)).thread.status).not.toBe("aborted");
    } finally {
      finish.resolve();
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
