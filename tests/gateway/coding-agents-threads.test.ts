import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  RuntimeSummarySchema,
} from "../../packages/contracts/src/index.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentRuntimeSummaryService } from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import {
  createCodingAgentThreadStore,
  createFakeCodingAgentProvider,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };
const baseNow = new Date("2026-07-06T12:00:00.000Z");

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createHarness() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
  let currentPrincipal = ownerPrincipal;
  let tick = 0;
  const now = () => new Date(baseNow.getTime() + tick++ * 1000);
  const threads = createCodingAgentThreadStore({
    homePath,
    now,
    relationValidator: { validateCreate: async () => undefined },
    providers: [
      createFakeCodingAgentProvider({ providerId: "codex" }),
    ],
  });
  const summary = createCodingAgentRuntimeSummaryService({
    homePath,
    now,
    runtime: { id: "rt_primary", label: "Primary Matrix computer" },
    threads,
  });
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: summary,
    threads,
    getPrincipal: () => currentPrincipal,
  }));
  return {
    app,
    homePath,
    threads,
    setPrincipal: (principal: RequestPrincipal) => {
      currentPrincipal = principal;
    },
  };
}

const createBody = {
  providerId: "codex",
  prompt: "Inspect the failing tests and propose a small fix.",
  projectId: "repo-main",
  terminalSessionId: "main",
  mode: "default",
  approvalPolicy: "on_request",
  sandboxMode: "workspace_write",
  clientRequestId: "req_create_1",
};

function workspaceSessionIdForThread(threadId: string): string {
  return `sess_${threadId.slice("thread_".length)}`;
}

describe("coding agent thread lifecycle", () => {
  it("creates a thread idempotently and replays fake-provider events", async () => {
    const { app } = await createHarness();

    const first = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const duplicate = await app.request(jsonRequest("/api/coding-agents/threads", createBody));

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(200);
    const firstSnapshot = AgentThreadSnapshotSchema.parse(await first.json());
    const duplicateSnapshot = AgentThreadSnapshotSchema.parse(await duplicate.json());
    expect(duplicateSnapshot.thread.id).toBe(firstSnapshot.thread.id);
    expect(duplicateSnapshot.events.items.map((event) => event.eventId)).toEqual(
      firstSnapshot.events.items.map((event) => event.eventId),
    );
    expect(firstSnapshot.thread).toMatchObject({
      providerId: "codex",
      projectId: "repo-main",
      terminalSessionId: "main",
      status: "running",
      attention: "none",
    });
    expect(firstSnapshot.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.status",
      "assistant.text.delta",
    ]);

    const replay = await app.request(`/api/coding-agents/threads/${firstSnapshot.thread.id}/events`);
    expect(replay.status).toBe(200);
    expect(AgentThreadSnapshotSchema.parse(await replay.json()).events.items).toHaveLength(3);
  });

  it("aggregates every bounded owner project thread beyond the list page", async () => {
    const { threads } = await createHarness();
    for (let index = 0; index < 55; index += 1) {
      await threads.createThread(ownerPrincipal, {
        ...createBody,
        clientRequestId: `req_project_count_${index}`,
      });
    }
    await threads.createThread(otherPrincipal, {
      ...createBody,
      clientRequestId: "req_other_project_count",
    });

    const page = await threads.listThreads(ownerPrincipal);
    const counts = await threads.listProjectCounts(ownerPrincipal);

    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(counts).toEqual([{
      projectId: "repo-main",
      threadCount: 55,
      attentionCount: 0,
    }]);
  });

  it("replays events after a cursor and includes active threads in the runtime summary", async () => {
    const { app } = await createHarness();
    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());
    const firstCursor = snapshot.events.items[0]!.eventId;

    const replay = await app.request(`/api/coding-agents/threads/${snapshot.thread.id}/events?cursor=${firstCursor}`);
    const summary = await app.request("/api/coding-agents/summary");

    expect(replay.status).toBe(200);
    const replayBody = AgentThreadSnapshotSchema.parse(await replay.json());
    expect(replayBody.events.items.map((event) => event.type)).toEqual([
      "thread.status",
      "assistant.text.delta",
    ]);
    expect(RuntimeSummarySchema.parse(await summary.json()).activeThreads.items).toEqual([
      expect.objectContaining({ id: snapshot.thread.id, status: "running" }),
    ]);
  });

  it("rejects stale cursors instead of replaying from the beginning", async () => {
    const { app } = await createHarness();
    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());

    const replay = await app.request(`/api/coding-agents/threads/${snapshot.thread.id}/events?cursor=evt_missing`);

    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual({
      error: {
        code: "thread_not_found",
        safeMessage: "Thread is unavailable. Refresh and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  });

  it("continues replay after a cursor from the current snapshot window", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      relationValidator: { validateCreate: async () => undefined },
      providers: [createFakeCodingAgentProvider({ providerId: "codex", deltaCount: 250 })],
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: createCodingAgentRuntimeSummaryService({ homePath, now: () => baseNow }),
      threads,
      getPrincipal: () => ownerPrincipal,
    }));
    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());
    const createdCursor = snapshot.events.items[0]!.eventId;

    const replay = await app.request(`/api/coding-agents/threads/${snapshot.thread.id}/events?cursor=${createdCursor}`);
    const replayBody = AgentThreadSnapshotSchema.parse(await replay.json());

    expect(replayBody.events.items).toHaveLength(199);
    expect(replayBody.events.items[0]).toMatchObject({ type: "assistant.text.delta" });
    expect(replayBody.events.hasMore).toBe(false);
  });

  it("returns the latest bounded event window for thread snapshots without a cursor", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      relationValidator: { validateCreate: async () => undefined },
      providers: [createFakeCodingAgentProvider({ providerId: "codex", deltaCount: 250 })],
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: createCodingAgentRuntimeSummaryService({ homePath, now: () => baseNow }),
      threads,
      getPrincipal: () => ownerPrincipal,
    }));

    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());

    expect(snapshot.events.items).toHaveLength(200);
    expect(snapshot.events.hasMore).toBe(true);
    expect(snapshot.events.items.map((event) => event.type)).not.toContain("thread.created");
    expect(snapshot.events.items.at(-1)).toMatchObject({
      type: "assistant.text.delta",
      delta: "Agent event 250.",
    });
  });

  it("keeps thread ownership isolated and maps missing threads to safe errors", async () => {
    const { app, setPrincipal } = await createHarness();
    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());

    setPrincipal(otherPrincipal);
    const read = await app.request(`/api/coding-agents/threads/${snapshot.thread.id}`);

    expect(read.status).toBe(404);
    expect(await read.json()).toEqual({
      error: {
        code: "thread_not_found",
        safeMessage: "Thread is unavailable. Refresh and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  });

  it("aborts one thread idempotently without duplicating terminal or provider state", async () => {
    const { app } = await createHarness();
    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());
    const abortBody = { clientRequestId: "req_abort_1" };

    const firstAbort = await app.request(jsonRequest(`/api/coding-agents/threads/${snapshot.thread.id}/abort`, abortBody));
    const duplicateAbort = await app.request(jsonRequest(`/api/coding-agents/threads/${snapshot.thread.id}/abort`, abortBody));

    expect(firstAbort.status).toBe(200);
    expect(duplicateAbort.status).toBe(200);
    const aborted = AgentThreadSnapshotSchema.parse(await firstAbort.json());
    const duplicate = AgentThreadSnapshotSchema.parse(await duplicateAbort.json());
    expect(aborted.thread.status).toBe("aborted");
    expect(aborted.thread.attention).toBe("none");
    expect(duplicate.events.items.map((event) => event.eventId)).toEqual(
      aborted.events.items.map((event) => event.eventId),
    );
    expect(aborted.events.items.at(-1)).toMatchObject({
      type: "thread.completed",
      outcome: "aborted",
    });
  });

  it("clears pending attention on abort and preserves already-final threads", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    let tick = 0;
    const now = () => new Date(baseNow.getTime() + tick++ * 1000);
    const threads = createCodingAgentThreadStore({
      homePath,
      now,
      providers: [
        {
          providerId: "codex",
          startThread({ thread, now: providerNow, nextEventId }) {
            return [
              AgentThreadEventSchema.parse({
                type: "approval.requested",
                eventId: nextEventId(),
                threadId: thread.id,
                occurredAt: providerNow().toISOString(),
                approval: {
                  approvalId: "appr_test",
                  threadId: thread.id,
                  title: "Confirm action",
                  safeDescription: "Approve the next step.",
                  risk: "low",
                  actionKind: "other",
                  allowedDecisions: ["approve", "decline"],
                  correlationId: "corr_test",
                },
              }),
            ];
          },
        },
      ],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);

    const aborted = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_attention");
    const duplicate = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_after_final");

    expect(created.snapshot.thread).toMatchObject({
      status: "waiting_for_approval",
      attention: "approval_required",
    });
    expect(aborted.thread).toMatchObject({ status: "aborted", attention: "none" });
    expect(duplicate.events.items.map((event) => event.eventId)).toEqual(
      aborted.events.items.map((event) => event.eventId),
    );
  });

  it("reconciles active threads when the bound terminal session exits", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const published: Array<{ ownerId: string; threadId: string; events: unknown[] }> = [];
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [createFakeCodingAgentProvider({ providerId: "codex" })],
    });
    threads.registerEventSink((event) => {
      published.push(event);
    });
    const created = await threads.createThread(ownerPrincipal, createBody);

    const reconciled = await threads.reconcileTerminalSessionStopped({
      ownerId: ownerPrincipal.userId,
      terminalSessionId: "main",
      runtimeStatus: "exited",
    });
    const duplicate = await threads.reconcileTerminalSessionStopped({
      ownerId: ownerPrincipal.userId,
      terminalSessionId: "main",
      runtimeStatus: "exited",
    });

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.thread).toMatchObject({
      id: created.snapshot.thread.id,
      status: "completed",
      attention: "none",
    });
    expect(reconciled[0]?.events.items.at(-2)).toMatchObject({
      type: "thread.status",
      status: "completed",
    });
    expect(reconciled[0]?.events.items.at(-1)).toMatchObject({
      type: "thread.completed",
      outcome: "completed",
    });
    expect(duplicate).toEqual([]);
    expect(published.at(-1)).toMatchObject({
      ownerId: ownerPrincipal.userId,
      threadId: created.snapshot.thread.id,
      events: [
        expect.objectContaining({ type: "thread.status", status: "completed" }),
        expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
      ],
    });
  });

  it("reconciles stopped terminal sessions only for the matching owner and workspace session", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [createFakeCodingAgentProvider({ providerId: "codex" })],
    });
    const ownerThread = await threads.createThread(ownerPrincipal, createBody);
    const otherThread = await threads.createThread(otherPrincipal, {
      ...createBody,
      clientRequestId: "req_create_other_owner",
    });

    const reconciled = await threads.reconcileTerminalSessionStopped({
      ownerId: otherPrincipal.userId,
      workspaceSessionId: workspaceSessionIdForThread(otherThread.snapshot.thread.id),
      terminalSessionId: "main",
      runtimeStatus: "exited",
    });

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.thread).toMatchObject({
      id: otherThread.snapshot.thread.id,
      status: "completed",
    });
    expect(await threads.getThread(ownerPrincipal, ownerThread.snapshot.thread.id)).toMatchObject({
      thread: {
        id: ownerThread.snapshot.thread.id,
        status: "running",
      },
    });
  });

  it("retains pending stops for reused terminal ids when the workspace session id is different", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [createFakeCodingAgentProvider({ providerId: "codex" })],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);
    await threads.reconcileTerminalSessionStopped({
      ownerId: ownerPrincipal.userId,
      workspaceSessionId: workspaceSessionIdForThread(created.snapshot.thread.id),
      terminalSessionId: "main",
      runtimeStatus: "exited",
    });

    const reused = await threads.reconcileTerminalSessionStopped({
      ownerId: ownerPrincipal.userId,
      workspaceSessionId: "sess_reused_terminal",
      terminalSessionId: "main",
      runtimeStatus: "failed",
    });
    const raw = JSON.parse(await readFile(join(homePath, "system", "coding-agents", "threads.json"), "utf-8"));

    expect(reused).toEqual([]);
    expect(raw.pendingTerminalStops).toEqual([
      expect.objectContaining({
        ownerId: ownerPrincipal.userId,
        workspaceSessionId: "sess_reused_terminal",
        terminalSessionId: "main",
        runtimeStatus: "failed",
      }),
    ]);
  });

  it("applies a pending terminal stop when a later thread binds the same terminal", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [createFakeCodingAgentProvider({ providerId: "codex" })],
    });

    const early = await threads.reconcileTerminalSessionStopped({
      ownerId: ownerPrincipal.userId,
      terminalSessionId: "main",
      runtimeStatus: "failed",
    });
    const created = await threads.createThread(ownerPrincipal, createBody);
    const duplicate = await threads.reconcileTerminalSessionStopped({
      ownerId: ownerPrincipal.userId,
      terminalSessionId: "main",
      runtimeStatus: "failed",
    });
    const later = await threads.createThread(ownerPrincipal, {
      ...createBody,
      clientRequestId: "req_create_after_duplicate_stop",
    });
    const attention = await threads.listAttentionThreads(ownerPrincipal);

    expect(early).toEqual([]);
    expect(created.snapshot.thread).toMatchObject({
      status: "failed",
      attention: "failed",
      terminalSessionId: "main",
    });
    expect(created.snapshot.events.items.at(-2)).toMatchObject({
      type: "thread.status",
      status: "failed",
    });
    expect(created.snapshot.events.items.at(-1)).toMatchObject({
      type: "thread.completed",
      outcome: "failed",
    });
    expect(duplicate).toEqual([]);
    expect(later.snapshot.thread).toMatchObject({
      status: "running",
      attention: "none",
      terminalSessionId: "main",
    });
    expect(attention.items).toEqual([
      expect.objectContaining({
        id: created.snapshot.thread.id,
        status: "failed",
        attention: "failed",
      }),
    ]);
    expect(attention.hasMore).toBe(false);
  });

  it("surfaces failed status-only threads in the attention list", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "failed",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      relationValidator: { validateCreate: async () => undefined },
      providers: [provider],
    });

    const created = await threads.createThread(ownerPrincipal, createBody);
    const active = await threads.listThreads(ownerPrincipal);
    const attention = await threads.listAttentionThreads(ownerPrincipal);

    expect(created.snapshot.thread).toMatchObject({
      status: "failed",
      attention: "failed",
    });
    expect(active.items).toEqual([]);
    expect(attention.items).toEqual([
      expect.objectContaining({
        id: created.snapshot.thread.id,
        status: "failed",
        attention: "failed",
      }),
    ]);
  });

  it("normalizes legacy failed threads with missing attention on read", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [createFakeCodingAgentProvider({ providerId: "codex" })],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);
    const statePath = join(homePath, "system", "coding-agents", "threads.json");
    const raw = JSON.parse(await readFile(statePath, "utf-8"));
    raw.threads = raw.threads.map((thread: { id: string }) => (
      thread.id === created.snapshot.thread.id
        ? { ...thread, status: "failed", attention: "none" }
        : thread
    ));
    await writeFile(statePath, JSON.stringify(raw), "utf-8");

    const attention = await threads.listAttentionThreads(ownerPrincipal);
    const snapshot = await threads.getThread(ownerPrincipal, created.snapshot.thread.id);

    expect(attention.items).toEqual([
      expect.objectContaining({
        id: created.snapshot.thread.id,
        status: "failed",
        attention: "failed",
      }),
    ]);
    expect(snapshot.thread).toMatchObject({
      id: created.snapshot.thread.id,
      status: "failed",
      attention: "failed",
    });
  });

  it("submits approval decisions idempotently through the provider adapter", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    let approvalCalls = 0;
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "approval.requested",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            approval: {
              approvalId: "appr_test",
              threadId: thread.id,
              title: "Confirm action",
              safeDescription: "Approve the next step.",
              risk: "low",
              actionKind: "other",
              allowedDecisions: ["approve", "decline"],
              correlationId: "corr_test",
            },
          }),
        ];
      },
      submitApproval({ thread, approvalId, request, now: providerNow, nextEventId }) {
        approvalCalls += 1;
        expect(approvalId).toBe("appr_test");
        expect(request).toEqual({
          decision: "approve",
          clientRequestId: "req_approval_1",
          correlationId: "corr_test",
        });
        return [
          AgentThreadEventSchema.parse({
            type: "approval.resolved",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            approvalId,
            decision: request.decision,
          }),
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      relationValidator: { validateCreate: async () => undefined },
      providers: [provider],
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: createCodingAgentRuntimeSummaryService({ homePath, now: () => baseNow }),
      threads,
      getPrincipal: () => ownerPrincipal,
    }));
    const created = AgentThreadSnapshotSchema.parse(
      await (await app.request(jsonRequest("/api/coding-agents/threads", createBody))).json(),
    );
    const body = {
      decision: "approve",
      clientRequestId: "req_approval_1",
      correlationId: "corr_test",
    };

    const first = await app.request(jsonRequest(`/api/coding-agents/threads/${created.thread.id}/approvals/appr_test/decision`, body));
    const duplicate = await app.request(jsonRequest(`/api/coding-agents/threads/${created.thread.id}/approvals/appr_test/decision`, body));
    const oversized = await app.request(new Request(`http://localhost/api/coding-agents/threads/${created.thread.id}/approvals/appr_test/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(9_000) },
      body: JSON.stringify(body),
    }));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(oversized.status).toBe(413);
    expect(approvalCalls).toBe(1);
    const decided = AgentThreadSnapshotSchema.parse(await first.json());
    const duplicateSnapshot = AgentThreadSnapshotSchema.parse(await duplicate.json());
    expect(decided.thread).toMatchObject({ status: "running", attention: "none" });
    expect(decided.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "approval.requested",
      "approval.resolved",
      "thread.status",
    ]);
    expect(duplicateSnapshot.events.items.map((event) => event.eventId)).toEqual(
      decided.events.items.map((event) => event.eventId),
    );
  });

  it("submits user input answers idempotently and safely validates route input", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    let inputCalls = 0;
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "user_input.requested",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            request: {
              requestId: "req_input_prompt",
              threadId: thread.id,
              title: "Need input",
              safeDescription: "Provide the missing detail.",
              required: true,
              correlationId: "corr_input",
            },
          }),
        ];
      },
      submitInput({ thread, inputRequestId, request, now: providerNow, nextEventId }) {
        inputCalls += 1;
        expect(inputRequestId).toBe("req_input_prompt");
        expect(request.answer).toBe("Use the safe implementation path.");
        return [
          AgentThreadEventSchema.parse({
            type: "user_input.answered",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            requestId: inputRequestId,
            correlationId: request.correlationId,
          }),
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      relationValidator: { validateCreate: async () => undefined },
      providers: [provider],
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: createCodingAgentRuntimeSummaryService({ homePath, now: () => baseNow }),
      threads,
      getPrincipal: () => ownerPrincipal,
    }));
    const created = AgentThreadSnapshotSchema.parse(
      await (await app.request(jsonRequest("/api/coding-agents/threads", createBody))).json(),
    );
    const body = {
      answer: "Use the safe implementation path.",
      clientRequestId: "req_input_1",
      correlationId: "corr_input",
    };

    const first = await app.request(jsonRequest(`/api/coding-agents/threads/${created.thread.id}/inputs/req_input_prompt/answer`, body));
    const duplicate = await app.request(jsonRequest(`/api/coding-agents/threads/${created.thread.id}/inputs/req_input_prompt/answer`, body));
    const malformed = await app.request(jsonRequest(`/api/coding-agents/threads/${created.thread.id}/inputs/../answer`, body));
    const oversized = await app.request(new Request(`http://localhost/api/coding-agents/threads/${created.thread.id}/inputs/req_input_prompt/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(45_000) },
      body: JSON.stringify(body),
    }));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(malformed.status).toBe(404);
    expect(oversized.status).toBe(413);
    expect(inputCalls).toBe(1);
    const answered = AgentThreadSnapshotSchema.parse(await first.json());
    const duplicateSnapshot = AgentThreadSnapshotSchema.parse(await duplicate.json());
    expect(answered.thread).toMatchObject({ status: "running", attention: "none" });
    expect(answered.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "user_input.requested",
      "user_input.answered",
      "thread.status",
    ]);
    expect(duplicateSnapshot.events.items.map((event) => event.eventId)).toEqual(
      answered.events.items.map((event) => event.eventId),
    );
  });

  it("records a safe failed thread when a provider start fails", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [
        {
          providerId: "codex",
          startThread() {
            throw new Error("Postgres constraint failed in /home/matrix/private/provider.log");
          },
        },
      ],
    });

    const created = await threads.createThread(ownerPrincipal, createBody);

    expect(created.snapshot.thread).toMatchObject({
      status: "failed",
      attention: "failed",
    });
    expect(created.snapshot.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.error",
      "thread.completed",
    ]);
    expect(created.snapshot.events.items[1]).toMatchObject({
      type: "thread.error",
      error: {
        code: "provider_run_failed",
        safeMessage: "Agent run could not continue. Try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
    expect(JSON.stringify(created.snapshot)).not.toMatch(/Postgres|\/home\/matrix|provider\.log/);
  });

  it("delegates abort to the provider adapter once and stores normalized abort events", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    let abortCalls = 0;
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
      abortThread({ thread, now: providerNow, nextEventId, clientRequestId }) {
        abortCalls += 1;
        expect(clientRequestId).toBe("req_abort_provider");
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "aborted",
          }),
          AgentThreadEventSchema.parse({
            type: "assistant.text.completed",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            messageId: "msg_abort_ack",
          }),
          AgentThreadEventSchema.parse({
            type: "thread.completed",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            outcome: "aborted",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [provider],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);

    const aborted = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_provider");
    const duplicate = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_provider");

    expect(abortCalls).toBe(1);
    expect(aborted.thread.status).toBe("aborted");
    expect(aborted.events.items.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.status",
      "thread.status",
      "assistant.text.completed",
      "thread.completed",
    ]);
    expect(aborted.events.items.at(-2)).toMatchObject({
      type: "assistant.text.completed",
      messageId: "msg_abort_ack",
    });
    expect(duplicate.events.items.map((event) => event.eventId)).toEqual(
      aborted.events.items.map((event) => event.eventId),
    );
  });

  it("forces provider abort output to finish with an aborted thread", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
      abortThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [provider],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);

    const aborted = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_nonterminal");

    expect(aborted.thread.status).toBe("aborted");
    expect(aborted.events.items.at(-1)).toMatchObject({
      type: "thread.completed",
      outcome: "aborted",
      threadId: created.snapshot.thread.id,
    });
  });

  it("replaces provider abort output that reports a completed terminal outcome", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
      abortThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.completed",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            outcome: "completed",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [provider],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);

    const aborted = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_completed_output");

    expect(aborted.thread.status).toBe("aborted");
    expect(aborted.events.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
    expect(aborted.events.items.at(-1)).toMatchObject({
      type: "thread.completed",
      outcome: "aborted",
      threadId: created.snapshot.thread.id,
    });
  });

  it("rejects provider events for the wrong thread before storing them", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    let wrongThreadId = "thread_other";
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread({ thread, now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.status",
            eventId: nextEventId(),
            threadId: thread.id,
            occurredAt: providerNow().toISOString(),
            status: "running",
          }),
        ];
      },
      abortThread({ now: providerNow, nextEventId }) {
        return [
          AgentThreadEventSchema.parse({
            type: "thread.completed",
            eventId: nextEventId(),
            threadId: wrongThreadId,
            occurredAt: providerNow().toISOString(),
            outcome: "aborted",
          }),
        ];
      },
    };
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
      providers: [provider],
    });
    const created = await threads.createThread(ownerPrincipal, createBody);
    const other = await threads.createThread(ownerPrincipal, {
      ...createBody,
      clientRequestId: "req_create_other",
    });
    wrongThreadId = other.snapshot.thread.id;
    const rawBefore = JSON.parse(await readFile(join(homePath, "system", "coding-agents", "threads.json"), "utf-8"));
    const wrongThreadEventCount = rawBefore.events.filter((event: { threadId?: string }) => event.threadId === wrongThreadId).length;

    const aborted = await threads.abortThread(ownerPrincipal, created.snapshot.thread.id, "req_abort_wrong_thread");
    const rawAfter = JSON.parse(await readFile(join(homePath, "system", "coding-agents", "threads.json"), "utf-8"));

    expect(aborted.thread.status).toBe("aborted");
    expect(aborted.events.items.every((event) => event.threadId === created.snapshot.thread.id)).toBe(true);
    expect(rawAfter.events.filter((event: { threadId?: string }) => event.threadId === wrongThreadId)).toHaveLength(wrongThreadEventCount);
  });

  it("rejects unauthenticated, oversized, invalid provider, and unsafe route input", async () => {
    const { app, setPrincipal } = await createHarness();

    const invalidProvider = await app.request(jsonRequest("/api/coding-agents/threads", {
      ...createBody,
      providerId: "opencode",
      clientRequestId: "req_create_2",
    }));
    const unsafeThreadId = await app.request("/api/coding-agents/threads/../secret");
    const oversized = await app.request(new Request("http://localhost/api/coding-agents/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(150_000) },
      body: JSON.stringify({ ...createBody, prompt: "x".repeat(150_000), clientRequestId: "req_create_3" }),
    }));
    setPrincipal({
      get userId(): string {
        throw new MissingRequestPrincipalError();
      },
      source: "jwt",
    } as RequestPrincipal);
    const unauthenticated = await app.request(jsonRequest("/api/coding-agents/threads", createBody));

    expect(invalidProvider.status).toBe(400);
    expect(await invalidProvider.json()).toEqual({
      error: {
        code: "provider_unavailable",
        safeMessage: "Selected provider is unavailable. Choose another provider or try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
    expect(unsafeThreadId.status).toBe(404);
    expect(oversized.status).toBe(413);
    expect(unauthenticated.status).toBe(401);
  });

  it("persists thread state in owner files instead of client-local storage", async () => {
    const { app, homePath } = await createHarness();
    const created = await app.request(jsonRequest("/api/coding-agents/threads", createBody));
    const snapshot = AgentThreadSnapshotSchema.parse(await created.json());

    const raw = await readFile(join(homePath, "system", "coding-agents", "threads.json"), "utf-8");

    expect(raw).toContain(snapshot.thread.id);
    expect(raw).toContain("owner_user");
    expect(raw).not.toMatch(/Inspect the failing tests/);
  });
});
