import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  AgentThreadSnapshotSchema,
  CreateAgentTurnResponseSchema,
} from "../../packages/contracts/src/index.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import {
  createCodingAgentThreadStore,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import { CodingAgentThreadRelationError } from "../../packages/gateway/src/coding-agents/thread-relations.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };
const now = new Date("2026-07-10T12:00:00.000Z");

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const turnBody = {
  message: "Continue with the smallest safe implementation.",
  clientRequestId: "req_turn_continue_1",
};

async function createHarness(options: { initialOutcome?: "completed" | "aborted" } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-turns-"));
  const validateThread = vi.fn(async () => undefined);
  const provider: CodingAgentProviderAdapter = {
    providerId: "codex",
    startThread({ thread, now: providerNow, nextEventId }) {
      return [{
        type: "thread.completed",
        eventId: nextEventId(),
        threadId: thread.id,
        occurredAt: providerNow().toISOString(),
        outcome: options.initialOutcome ?? "completed",
      }];
    },
  };
  const threads = createCodingAgentThreadStore({
    homePath,
    providers: [provider],
    relationValidator: {
      validateCreate: async () => undefined,
      validateThread,
    },
    now: () => now,
  });
  const created = await threads.createThread(ownerPrincipal, {
    providerId: "codex",
    prompt: "Start the implementation.",
    projectId: "matrix-os",
    taskId: "task_auth",
    clientRequestId: "req_thread_turn_fixture",
  });
  let principal = ownerPrincipal;
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: vi.fn() },
    threads,
    turns: threads,
    getPrincipal: () => principal,
  }));
  return {
    app,
    homePath,
    threadId: created.snapshot.thread.id,
    threads,
    validateThread,
    setPrincipal(value: RequestPrincipal) {
      principal = value;
    },
  };
}

describe("coding agent same-thread turns", () => {
  it("GW-012 GW-013 accepts and replays one bounded user turn", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.request(post(
        `/api/coding-agents/threads/${harness.threadId}/turns`,
        turnBody,
      ));
      const accepted = CreateAgentTurnResponseSchema.parse(await response.json());
      const snapshot = await harness.threads.getThread(ownerPrincipal, harness.threadId);

      expect(response.status).toBe(202);
      expect(accepted).toMatchObject({
        threadId: harness.threadId,
        status: "accepted",
        acceptedAt: now.toISOString(),
      });
      expect(accepted.turnId).toMatch(/^turn_/);
      expect(snapshot.events.items).toContainEqual(expect.objectContaining({
        type: "turn.accepted",
        turnId: accepted.turnId,
        clientRequestId: turnBody.clientRequestId,
      }));
      expect(harness.validateThread).toHaveBeenCalledWith(ownerPrincipal, {
        projectId: "matrix-os",
        taskId: "task_auth",
      });
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-013 accepts a new turn after the prior run was aborted", async () => {
    const harness = await createHarness({ initialOutcome: "aborted" });
    try {
      const response = await harness.app.request(post(
        `/api/coding-agents/threads/${harness.threadId}/turns`,
        turnBody,
      ));

      expect(response.status).toBe(202);
      expect(CreateAgentTurnResponseSchema.parse(await response.json())).toMatchObject({
        threadId: harness.threadId,
        status: "accepted",
      });
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-014 returns the original accepted turn for an idempotent retry", async () => {
    const harness = await createHarness();
    try {
      const path = `/api/coding-agents/threads/${harness.threadId}/turns`;
      const first = await harness.app.request(post(path, turnBody));
      const duplicate = await harness.app.request(post(path, turnBody));
      const firstBody = CreateAgentTurnResponseSchema.parse(await first.json());
      const duplicateBody = CreateAgentTurnResponseSchema.parse(await duplicate.json());
      const reloadedStore = createCodingAgentThreadStore({
        homePath: harness.homePath,
        providers: [{ providerId: "codex", startThread: () => [] }],
        relationValidator: {
          validateCreate: async () => undefined,
          validateThread: async () => undefined,
        },
        now: () => now,
      });
      const reloadedDuplicate = await reloadedStore.acceptTurn(
        ownerPrincipal,
        harness.threadId,
        turnBody,
      );

      expect(first.status).toBe(202);
      expect(duplicate.status).toBe(200);
      expect(duplicateBody).toEqual({ ...firstBody, status: "already_accepted" });
      expect(reloadedDuplicate).toEqual(duplicateBody);
      expect(harness.validateThread).toHaveBeenCalledTimes(1);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-015 allows one concurrent normal turn and returns a safe busy conflict", async () => {
    const harness = await createHarness();
    try {
      const path = `/api/coding-agents/threads/${harness.threadId}/turns`;
      const [first, second] = await Promise.all([
        harness.app.request(post(path, { ...turnBody, clientRequestId: "req_turn_parallel_1" })),
        harness.app.request(post(path, { ...turnBody, clientRequestId: "req_turn_parallel_2" })),
      ]);
      const responses = [first, second].sort((left, right) => left.status - right.status);

      expect(responses.map((response) => response.status)).toEqual([202, 409]);
      expect(await responses[1]!.json()).toEqual({
        error: {
          code: "thread_busy",
          safeMessage: "This conversation is already running. Wait for it to finish and try again.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      });
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-012 applies auth, body limit, params, ownership, and request validation", async () => {
    const harness = await createHarness();
    try {
      const validPath = `/api/coding-agents/threads/${harness.threadId}/turns`;
      const invalidBody = await harness.app.request(post(validPath, {
        message: "",
        clientRequestId: "req_turn_invalid",
      }));
      const invalidThread = await harness.app.request(post(
        "/api/coding-agents/threads/not-a-thread/turns",
        turnBody,
      ));
      const oversized = await harness.app.request(new Request(`http://localhost${validPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(150_000) },
        body: JSON.stringify({ ...turnBody, message: "x".repeat(140_000) }),
      }));
      harness.validateThread.mockRejectedValueOnce(
        new CodingAgentThreadRelationError("invalid_relation"),
      );
      const staleRelation = await harness.app.request(post(validPath, {
        ...turnBody,
        clientRequestId: "req_turn_stale_relation",
      }));
      harness.setPrincipal(otherPrincipal);
      const otherOwner = await harness.app.request(post(validPath, turnBody));
      harness.setPrincipal({
        get userId(): string { throw new MissingRequestPrincipalError(); },
        source: "jwt",
      } as RequestPrincipal);
      const unauthenticated = await harness.app.request(post(validPath, turnBody));

      expect(invalidBody.status).toBe(400);
      expect(invalidThread.status).toBe(400);
      expect(oversized.status).toBe(413);
      expect(staleRelation.status).toBe(409);
      expect(await staleRelation.json()).toEqual({
        error: {
          code: "turn_unavailable",
          safeMessage: "This conversation cannot accept a message right now. Refresh and try again.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      });
      expect(otherOwner.status).toBe(404);
      expect(unauthenticated.status).toBe(401);
      expect(JSON.stringify(await otherOwner.json())).not.toMatch(/owner_user|matrix-os|task_auth/);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });
});
