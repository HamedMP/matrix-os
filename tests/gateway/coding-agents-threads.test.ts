import { mkdtemp, readFile } from "node:fs/promises";
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

  it("returns the first replay window after the cursor", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-threads-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      now: () => baseNow,
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

    expect(replayBody.events.items).toHaveLength(200);
    expect(replayBody.events.items[0]).toMatchObject({ type: "thread.status" });
    expect(replayBody.events.hasMore).toBe(true);
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
