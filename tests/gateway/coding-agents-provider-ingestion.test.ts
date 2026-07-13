import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentThreadEventSchema,
  type AgentThreadEvent,
} from "../../packages/contracts/src/index.js";
import {
  CodingAgentThreadError,
  createCodingAgentThreadStore,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

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
