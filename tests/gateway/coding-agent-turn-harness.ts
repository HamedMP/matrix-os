import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { vi } from "vitest";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import {
  createCodingAgentThreadStore,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

export const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
export const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };
export const turnNow = new Date("2026-07-10T12:00:00.000Z");

export function postTurn(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const turnBody = {
  message: "Continue with the smallest safe implementation.",
  clientRequestId: "req_turn_continue_1",
};

export async function createTurnHarness(options: {
  initialOutcome?: "completed" | "aborted";
  provider?: CodingAgentProviderAdapter;
  maxTurnDispatches?: number;
  turnDispatchTimeoutMs?: number;
} = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-turns-"));
  const validateThread = vi.fn(async () => undefined);
  const provider: CodingAgentProviderAdapter = options.provider ?? {
    providerId: "codex",
    startThread({ thread, now, nextEventId }) {
      return {
        events: [{
          type: "thread.completed",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          outcome: options.initialOutcome ?? "completed",
        }],
        resumeState: { conversationId: "provider_conversation_fixture" },
      };
    },
    resumeTurn({ resumeState }) {
      return { events: [], outcome: "completed", resumeState };
    },
  };
  const threads = createCodingAgentThreadStore({
    homePath,
    providers: [provider],
    relationValidator: {
      validateCreate: async () => undefined,
      validateThread,
    },
    maxTurnDispatches: options.maxTurnDispatches,
    turnDispatchTimeoutMs: options.turnDispatchTimeoutMs,
    now: () => turnNow,
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
    async cleanup() {
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    },
    setPrincipal(value: RequestPrincipal) {
      principal = value;
    },
  };
}
