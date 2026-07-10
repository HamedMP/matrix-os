import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  AdoptAgentThreadResponseSchema,
  type CreateAgentThreadRequest,
} from "../../packages/contracts/src/index.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import {
  createCodingAgentThreadStore,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodingAgentThreadRelationValidator } from "../../packages/gateway/src/coding-agents/thread-relations.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { createTaskManager } from "../../packages/gateway/src/task-manager.js";

const owner: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const otherOwner: RequestPrincipal = { userId: "other_user", source: "jwt" };
const now = "2026-07-10T14:00:00.000Z";

const legacyCreate: CreateAgentThreadRequest = {
  providerId: "codex",
  prompt: "Continue the legacy conversation.",
  clientRequestId: "req_legacy_thread_create",
};

function adoptRequest(threadId: string, body: unknown): Request {
  return new Request(`http://localhost/api/coding-agents/threads/${threadId}/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createHarness(options: { projectionFailure?: Error } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-adoption-"));
  const projects = createProjectManager({ homePath, now: () => now });
  const tasks = createTaskManager({ homePath, now: () => now });
  await projects.createProject({
    mode: "scratch",
    slug: "matrix-os",
    name: "Matrix OS",
    ownerScope: { type: "user", id: owner.userId },
  });
  await projects.createProject({
    mode: "scratch",
    slug: "website",
    name: "Website",
    ownerScope: { type: "user", id: owner.userId },
  });
  const taskResult = await tasks.createTask("matrix-os", {
    title: "Harden authentication",
    status: "running",
  });
  if (!taskResult.ok) throw new Error("task fixture failed");

  const projectionPublisher = vi.fn(async (change: { thread: { id: string; projectId?: string } }) => {
    if (options.projectionFailure) throw options.projectionFailure;
    const persisted = JSON.parse(await readFile(
      join(homePath, "system", "coding-agents", "threads.json"),
      "utf8",
    )) as { threads: Array<{ id: string; projectId?: string }> };
    expect(persisted.threads.find((thread) => thread.id === change.thread.id)?.projectId)
      .toBe(change.thread.projectId);
  });
  const startThread = vi.fn<NonNullable<CodingAgentProviderAdapter["startThread"]>>(() => []);
  const threads = createCodingAgentThreadStore({
    homePath,
    providers: [{ providerId: "codex", startThread }],
    relationValidator: createCodingAgentThreadRelationValidator({
      projectManager: projects,
      taskManager: tasks,
      principalOwnerIds: [owner.userId],
    }),
    projectionPublisher,
    now: () => new Date(now),
  });
  let principal = owner;
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: vi.fn() },
    threads,
    getPrincipal: () => principal,
  }));

  return {
    app,
    homePath,
    projectionPublisher,
    taskId: taskResult.task.id,
    threads,
    setPrincipal(next: RequestPrincipal) {
      principal = next;
    },
  };
}

describe("coding agent legacy thread adoption", () => {
  it("adopts an owner legacy thread after persistence and makes exact retries idempotent", async () => {
    const harness = await createHarness();
    try {
      const legacy = await harness.threads.createThread(owner, legacyCreate);
      harness.projectionPublisher.mockClear();
      const body = {
        projectId: "matrix-os",
        taskId: harness.taskId,
        clientRequestId: "req_adopt_legacy_thread",
      };

      const first = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, body));
      const retry = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, body));

      expect(first.status).toBe(202);
      expect(retry.status).toBe(200);
      expect(AdoptAgentThreadResponseSchema.parse(await first.json())).toMatchObject({
        status: "adopted",
        thread: { id: legacy.snapshot.thread.id, projectId: "matrix-os", taskId: harness.taskId },
      });
      expect(AdoptAgentThreadResponseSchema.parse(await retry.json())).toMatchObject({
        status: "already_adopted",
        thread: { id: legacy.snapshot.thread.id, projectId: "matrix-os", taskId: harness.taskId },
      });
      expect(harness.projectionPublisher).toHaveBeenCalledTimes(1);
      expect(harness.projectionPublisher).toHaveBeenCalledWith(expect.objectContaining({
        type: "updated",
        thread: expect.objectContaining({ projectId: "matrix-os", taskId: harness.taskId }),
      }));
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("rejects cross-owner, invalid, and already-assigned adoption without publishing", async () => {
    const harness = await createHarness();
    try {
      const legacy = await harness.threads.createThread(owner, legacyCreate);
      const assigned = await harness.threads.createShellThread(owner, {
        ...legacyCreate,
        projectId: "matrix-os",
        clientRequestId: "req_assigned_thread_create",
      });
      harness.projectionPublisher.mockClear();
      const validBody = {
        projectId: "matrix-os",
        taskId: harness.taskId,
        clientRequestId: "req_adopt_legacy_thread",
      };

      harness.setPrincipal(otherOwner);
      const crossOwner = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, validBody));
      harness.setPrincipal(owner);
      const invalidTask = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, {
        ...validBody,
        taskId: "task_missing",
      }));
      const alreadyAssigned = await harness.app.request(adoptRequest(assigned.snapshot.thread.id, {
        ...validBody,
        projectId: "website",
        taskId: undefined,
      }));
      harness.setPrincipal({
        get userId(): string { throw new MissingRequestPrincipalError(); },
        source: "jwt",
      } as RequestPrincipal);
      const unauthenticated = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, validBody));

      expect(crossOwner.status).toBe(404);
      expect(invalidTask.status).toBe(400);
      expect(alreadyAssigned.status).toBe(400);
      expect(unauthenticated.status).toBe(401);
      for (const response of [crossOwner, invalidTask, alreadyAssigned, unauthenticated]) {
        expect(JSON.stringify(await response.json())).not.toMatch(/owner_user|task_missing|website|\/home\//i);
      }
      expect(harness.projectionPublisher).not.toHaveBeenCalled();
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("keeps persisted adoption successful when the activity projection is temporarily unavailable", async () => {
    const rawFailure = new Error("token=secret at /home/matrix/private");
    const harness = await createHarness({ projectionFailure: rawFailure });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const legacy = await harness.threads.createThread(owner, legacyCreate);
      harness.projectionPublisher.mockClear();

      const response = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, {
        projectId: "matrix-os",
        clientRequestId: "req_adopt_legacy_thread",
      }));

      expect(response.status).toBe(202);
      expect((await harness.threads.getThread(owner, legacy.snapshot.thread.id)).thread.projectId)
        .toBe("matrix-os");
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|\/home\/matrix/i);
    } finally {
      warn.mockRestore();
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("enforces the adoption body limit before parsing", async () => {
    const harness = await createHarness();
    try {
      const legacy = await harness.threads.createThread(owner, legacyCreate);
      const response = await harness.app.request(adoptRequest(legacy.snapshot.thread.id, {
        projectId: "matrix-os",
        clientRequestId: "req_adopt_legacy_thread",
        padding: "x".repeat(5 * 1024),
      }));

      expect(response.status).toBe(413);
      expect(JSON.stringify(await response.json())).not.toContain("x".repeat(64));
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("maps malformed adoption JSON to a safe validation error", async () => {
    const harness = await createHarness();
    try {
      const legacy = await harness.threads.createThread(owner, legacyCreate);
      const response = await harness.app.request(new Request(
        `http://localhost/api/coding-agents/threads/${legacy.snapshot.thread.id}/adopt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"projectId":',
        },
      ));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "validation_failed",
          safeMessage: "Request could not be processed. Check the inputs and try again.",
          retryable: false,
        },
      });
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });
});
