import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentThreadEventSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";
import type { CodingAgentProviderAdapter, CodingAgentProviderRunResult } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import { createCodingAgentThreadStore, type StoredThreadState } from "../../packages/gateway/src/coding-agents/thread-store.js";

const owner = { type: "personal" as const, ownerId: "owner_bootstrap_retry" };
const principal = { userId: owner.ownerId, source: "configured-container" as const };
const failedAt = "2026-10-16T08:18:51.000Z";
const retryAt = "2026-10-16T08:22:06.000Z";
const backgroundRef = { id: `bg_${"a".repeat(32)}` };
const nativeFailureRecord = `${JSON.stringify({ type: "turn.failed" })}\n`;

// The fixture reproduces the native bridge's first-record checkpoint, rather
// than treating any failed thread with a missing native ID as safe to replace.
function nativeFailureEvents(threadId: string, sessionId: string): AgentThreadEvent[] {
  const nativeId = (index: number) => `evt_codex_${createHash("sha256")
    .update(`${sessionId}:0:${index}`).digest("hex").slice(0, 32)}`;
  return [
    AgentThreadEventSchema.parse({
      type: "thread.error", eventId: nativeId(0), threadId, occurredAt: failedAt,
      error: { code: "provider_failed", safeMessage: "The coding agent stopped. Review the thread and try again.",
        retryable: true, recoveryActions: ["retry"] },
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed", eventId: nativeId(1), threadId, occurredAt: failedAt, outcome: "failed",
    }),
  ];
}

async function seedPreviouslyFailedRetry(homePath: string, threadId: string): Promise<void> {
  const path = join(homePath, "system", "coding-agents", "threads.json");
  const state = JSON.parse(await readFile(path, "utf8")) as StoredThreadState;
  const turnId = "turn_already_failed_retry";
  const requestId = "req_already_failed_retry";
  const event = (value: Record<string, unknown>) => AgentThreadEventSchema.parse({
    ...value, threadId, occurredAt: retryAt,
  });
  // This persisted state comes from the old admission path. Constructing it
  // directly keeps the regression valid once that path correctly refuses it.
  state.events.push(
    event({ type: "turn.accepted", eventId: "evt_old_retry_accepted", turnId,
      clientRequestId: requestId, acceptedAt: retryAt }),
    event({ type: "user.message", eventId: "evt_old_retry_message", turnId,
      messageId: "msg_old_retry", clientRequestId: requestId, text: "Previously failed retry." }),
    event({ type: "turn.status", eventId: "evt_old_retry_running", turnId, status: "running" }),
    event({ type: "turn.status", eventId: "evt_old_retry_failed", turnId, status: "failed" }),
    event({ type: "thread.error", eventId: "evt_old_retry_error",
      error: { code: "provider_run_failed", safeMessage: "Agent run could not continue. Try again.",
        retryable: true, recoveryActions: ["retry"] } }),
    event({ type: "thread.completed", eventId: "evt_old_retry_done", outcome: "failed" }),
  );
  state.turns.push({ ownerId: owner.ownerId, threadId, turnId, clientRequestId: requestId,
    status: "failed", acceptedAt: retryAt, updatedAt: retryAt });
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}

it.each([
  { earlierRetry: false, attempts: 1, concurrent: false },
  { earlierRetry: true, attempts: 1, concurrent: false },
  { earlierRetry: true, attempts: 2, concurrent: false },
  { earlierRetry: true, attempts: 2, concurrent: true },
])("retries only the new Full access prompt after a failed native bootstrap ($earlierRetry/$attempts/$concurrent)", async ({ earlierRetry, attempts, concurrent }) => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-bootstrap-retry-"));
  const requests: Parameters<CodingAgentProviderAdapter["startThread"]>[0]["request"][] = [];
  const resumeTurn = vi.fn(async () => { throw new Error("Fixture native conversation was never initialized"); });
  const provider: CodingAgentProviderAdapter = {
    providerId: "codex", backgroundExecution: true, resumeTurn,
    async startThread({ thread, request, now, nextEventId }): Promise<CodingAgentProviderRunResult> {
      requests.push(request);
      if (requests.length === 1) return {
        events: [{ type: "thread.status", eventId: nextEventId(), threadId: thread.id,
          occurredAt: now().toISOString(), status: "running" }],
        resumeState: { conversationId: `sess_${thread.id.slice("thread_".length)}`, backgroundRef },
      };
      return { events: [
        { type: "assistant.text.delta", eventId: nextEventId(), threadId: thread.id,
          occurredAt: now().toISOString(), messageId: "msg_recovered_bootstrap", delta: "New retry completed." },
        { type: "thread.completed", eventId: nextEventId(), threadId: thread.id,
          occurredAt: now().toISOString(), outcome: "completed" },
      ] };
    },
  };
  let currentTime = new Date("2026-10-16T08:18:50.000Z");
  const threads = createCodingAgentThreadStore({ homePath, providers: [provider], now: () => currentTime });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const original = await threads.createThread(principal, {
      providerId: "codex", prompt: "Original supervised prompt must not be replayed.", mode: "default",
      approvalPolicy: "on_request", sandboxMode: "workspace_write", clientRequestId: "req_first_bootstrap",
    });
    const threadId = original.snapshot.thread.id;
    const sessionId = `sess_${threadId.slice("thread_".length)}`;
    currentTime = new Date(failedAt);
    await threads.ingestProviderEvents(principal, threadId, {
      events: nativeFailureEvents(threadId, sessionId),
    }, { sessionId, offset: Buffer.byteLength(nativeFailureRecord, "utf8") });
    if (earlierRetry) await seedPreviouslyFailedRetry(homePath, threadId);
    currentTime = new Date(retryAt);
    expect((await threads.getThread(principal, threadId)).thread.status).toBe("failed");

    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const retryInput: Parameters<NonNullable<typeof adapter.resume>>[0] = {
      owner, chatId: "chat_bootstrap_retry", turnId: "cturn_new_bootstrap_retry", runId: "run_new_bootstrap_retry",
      prompt: "NEW retry only: open the public website.",
      parts: [{ type: "text" as const, text: "NEW retry only: open the public website." }],
      selection: { instanceId: "codex_default", model: "gpt-6.1-sol",
        options: [{ id: "effort", value: "low" }, { id: "service_tier", value: "priority" }] },
      interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal,
      resumeState: { conversationId: threadId },
    };
    const collect = async () => {
      const events: CanonicalProviderRunEvent[] = [];
      for await (const event of adapter.resume!(retryInput)) events.push(event);
      return events;
    };
    const collected: CanonicalProviderRunEvent[][] = [];
    if (concurrent) {
      // The canonical browser scope permits one active projection per run.
      // A duplicate must not bypass that gate or launch a second replacement.
      const results = await Promise.allSettled(Array.from({ length: attempts }, collect));
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      for (const result of results) {
        if (result.status === "fulfilled") collected.push(result.value);
        else expect(result.reason).toMatchObject({ message: "Browser run unavailable" });
      }
    } else for (let index = 0; index < attempts; index++) collected.push(await collect());

    expect(resumeTurn, "A bootstrap without native identity must not accept another native turn").not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      prompt: "NEW retry only: open the public website.", model: "gpt-6.1-sol",
      approvalPolicy: "never", sandboxMode: "full_access",
      modelOptions: [{ id: "effort", value: "low" }, { id: "service_tier", value: "priority" }],
    });
    const replacementIds = collected.map(events => {
      const replacement = events.find(event => event.type === "state.updated");
      expect(replacement).toBeDefined();
      const answer = events.filter(event => event.type === "assistant.delta");
      expect(answer.map(event => event.delta).join("")).toBe("New retry completed.");
      expect(answer.every(event => event.messageId === "msg_recovered_bootstrap")).toBe(true);
      expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
      return replacement?.type === "state.updated" ? replacement.state.conversationId : undefined;
    });
    expect(replacementIds[0]).not.toBe(threadId);
    expect(replacementIds.every(id => id === replacementIds[0])).toBe(true);
    expect((await threads.getThread(principal, threadId)).events.items).toContainEqual(expect.objectContaining({
      type: "user.message", text: "Original supervised prompt must not be replayed.",
    }));
  } finally {
    await threads.shutdownTurns();
    warnings.mockRestore();
    await rm(homePath, { recursive: true, force: true });
  }
});

it.each(["foreign-owner", "disabled-harness", "relation-denied", "capacity"] as const)(
  "keeps retry recovery behind %s admission", async (mode) => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-codex-bootstrap-admission-"));
    let enabled = true, relationAllowed = true;
    const relationError = new Error("Fixture relation denied");
    const startThread = vi.fn(async ({ thread, now, nextEventId }: Parameters<CodingAgentProviderAdapter["startThread"]>[0]): Promise<CodingAgentProviderRunResult> => ({
      events: [{ type: "thread.status", eventId: nextEventId(), threadId: thread.id,
        occurredAt: now().toISOString(), status: "running" }],
      resumeState: { conversationId: `sess_${thread.id.slice("thread_".length)}`, backgroundRef },
    }));
    const provider: CodingAgentProviderAdapter = { providerId: "codex", startThread,
      resumeTurn: ({ signal }) => new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("Fixture turn cancelled"));
        if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
      }),
    };
    const threads = createCodingAgentThreadStore({ homePath, providers: [provider], maxTurnDispatches: 1,
      providerAdmission: { isProviderEnabled: async () => enabled },
      relationValidator: { validateCreate: async () => undefined, validateThread: async () => {
        if (!relationAllowed) throw relationError;
      } },
      now: () => new Date(retryAt),
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const original = await threads.createThread(principal, { providerId: "codex", prompt: "Initial prompt.",
        mode: "default", projectId: "project_fixture", clientRequestId: "req_initial_admission" });
      const threadId = original.snapshot.thread.id, sessionId = `sess_${threadId.slice("thread_".length)}`;
      await threads.ingestProviderEvents(principal, threadId, { events: nativeFailureEvents(threadId, sessionId) },
        { sessionId, offset: Buffer.byteLength(nativeFailureRecord) });
      if (mode === "disabled-harness") enabled = false;
      if (mode === "relation-denied") relationAllowed = false;
      if (mode === "capacity") {
        const busy = await threads.createThread(principal, { providerId: "codex", prompt: "Occupied.", mode: "default",
          clientRequestId: "req_capacity_fixture" });
        await threads.acceptTurn(principal, busy.snapshot.thread.id, { message: "Remain active.", clientRequestId: "req_busy_turn" });
      }
      const retry = threads.acceptTurn(mode === "foreign-owner" ? { ...principal, userId: "owner_other" } : principal,
        threadId, { message: "New retry.", approvalPolicy: "never", sandboxMode: "full_access", clientRequestId: "req_blocked_retry" });
      if (mode === "relation-denied") await expect(retry).rejects.toBe(relationError);
      else await expect(retry).rejects.toMatchObject({ code: mode === "foreign-owner" ? "thread_not_found" : "turn_unavailable" });
      expect(startThread).toHaveBeenCalledTimes(mode === "capacity" ? 2 : 1);
    } finally {
      await threads.shutdownTurns();
      warnings.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  },
);
