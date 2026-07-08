import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  type AgentThreadEvent,
  type AgentThreadSummary,
} from "@matrix-os/contracts";
import {
  CodingAgentThreadError,
  createCodingAgentThreadStore,
  createFakeCodingAgentProvider,
  type CodingAgentThreadStore,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import {
  createCodingAgentThreadStream,
  threadStreamFrameDataToString,
  type CodingAgentThreadStreamSocket,
} from "../../packages/gateway/src/coding-agents/thread-stream.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-07-06T12:00:00.000Z");

function socket(options: { throwOnSend?: boolean } = {}): CodingAgentThreadStreamSocket & { sent: unknown[]; closed: boolean } {
  return {
    sent: [],
    closed: false,
    send(data: string) {
      if (options.throwOnSend) {
        throw new Error("send failed");
      }
      this.sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
    },
  };
}

async function createHarness(options: { maxSubscribers?: number; subscriberTtlMs?: number } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-stream-"));
  const threads = createCodingAgentThreadStore({
    homePath,
    now: () => now,
    providers: [createFakeCodingAgentProvider({ providerId: "codex" })],
  });
  const stream = createCodingAgentThreadStream({
    threads,
    maxSubscribers: options.maxSubscribers,
    subscriberTtlMs: options.subscriberTtlMs,
  });
  const created = await threads.createThread(testPrincipal, {
    providerId: "codex",
    prompt: "Run tests.",
    clientRequestId: "req_stream_create",
  });
  return { threads, stream, threadId: created.snapshot.thread.id };
}

describe("coding agent thread stream", () => {
  it("replays the thread snapshot before delivering live events", async () => {
    const { threads, stream, threadId } = await createHarness();
    const ws = socket();

    const session = await stream.open({
      ws,
      principal: testPrincipal,
      threadId,
      cursor: undefined,
    });
    await threads.abortThread(testPrincipal, threadId, "req_abort_stream");

    expect(ws.sent[0]).toEqual({ type: "thread.stream.attached", threadId });
    expect(ws.sent.map((frame) => (frame as { type?: string }).type)).toEqual([
      "thread.stream.attached",
      "thread.event",
      "thread.event",
      "thread.event",
      "thread.replay.end",
      "thread.event",
      "thread.event",
    ]);
    expect(ws.sent.at(-1)).toMatchObject({
      type: "thread.event",
      event: { type: "thread.completed", outcome: "aborted" },
    });
    session.onClose();
  });

  it("does not drop events committed while attach replay is loading", async () => {
    const threadId = "thread_attach_race";
    const thread: AgentThreadSummary = {
      id: threadId,
      providerId: "codex",
      title: "Run tests.",
      status: "running",
      attention: "none",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const createdEvent = AgentThreadEventSchema.parse({
      type: "thread.created",
      eventId: "evt_created",
      threadId,
      occurredAt: now.toISOString(),
      thread,
    });
    const liveEvent = AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: "evt_live_completed",
      threadId,
      occurredAt: now.toISOString(),
      outcome: "completed",
    });
    let eventSink: ((input: { ownerId: string; threadId: string; events: AgentThreadEvent[] }) => void) | undefined;
    const threads: CodingAgentThreadStore = {
      async createThread() {
        throw new Error("not used");
      },
      async listThreads() {
        return { items: [], hasMore: false, limit: 50 };
      },
      async getThread() {
        eventSink?.({ ownerId: testPrincipal.userId, threadId, events: [liveEvent] });
        return AgentThreadSnapshotSchema.parse({
          thread,
          events: {
            items: [createdEvent],
            hasMore: false,
            nextCursor: createdEvent.eventId,
            limit: 200,
          },
        });
      },
      async abortThread() {
        throw new Error("not used");
      },
      registerEventSink(sink) {
        eventSink = sink;
        return {
          dispose() {
            eventSink = undefined;
          },
        };
      },
    };
    const stream = createCodingAgentThreadStream({ threads });
    const ws = socket();

    const session = await stream.open({ ws, principal: testPrincipal, threadId });

    expect(ws.sent.map((frame) => (frame as { type?: string }).type)).toEqual([
      "thread.stream.attached",
      "thread.event",
      "thread.replay.end",
      "thread.event",
    ]);
    expect(ws.sent.at(-1)).toMatchObject({
      type: "thread.event",
      event: { type: "thread.completed", outcome: "completed" },
    });
    session.onClose();
  });

  it("supports cursor replay and rejects stale cursors safely", async () => {
    const { stream, threadId } = await createHarness();
    const first = socket();
    await stream.open({ ws: first, principal: testPrincipal, threadId });
    const cursor = (first.sent.find((frame) =>
      (frame as { event?: { type?: string } }).event?.type === "thread.created"
    ) as { event: { eventId: string } }).event.eventId;

    const afterCursor = socket();
    await stream.open({ ws: afterCursor, principal: testPrincipal, threadId, cursor });
    const stale = socket();
    await stream.open({ ws: stale, principal: testPrincipal, threadId, cursor: "evt_missing" });

    expect(afterCursor.sent.map((frame) => (frame as { event?: { type?: string } }).event?.type).filter(Boolean)).toEqual([
      "thread.status",
      "assistant.text.delta",
    ]);
    expect(stale.sent).toEqual([
      {
        type: "thread.stream.error",
        error: {
          code: "thread_not_found",
          safeMessage: "Thread is unavailable. Refresh and try again.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      },
    ]);
    expect(stale.closed).toBe(true);
  });

  it("validates inbound frames, closes on detach, and normalizes binary frames", async () => {
    const { stream, threadId } = await createHarness();
    const ws = socket();
    const session = await stream.open({ ws, principal: testPrincipal, threadId });

    session.onMessage("{");
    session.onMessage(JSON.stringify({ type: "unknown" }));
    session.onMessage(threadStreamFrameDataToString(Buffer.from(JSON.stringify({ type: "ping" })))!);
    session.onMessage(JSON.stringify({ type: "detach" }));

    expect(ws.sent).toContainEqual({
      type: "thread.stream.error",
      error: {
        code: "invalid_frame",
        safeMessage: "Stream message was invalid. Refresh and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
    expect(ws.sent).toContainEqual({ type: "pong" });
    expect(ws.closed).toBe(true);
  });

  it("enforces subscriber caps, evicts stale subscribers, and removes failed senders", async () => {
    const { threads, stream, threadId } = await createHarness({ maxSubscribers: 1, subscriberTtlMs: 1 });
    const first = socket();
    const second = socket();
    const dead = socket({ throwOnSend: true });

    await stream.open({ ws: first, principal: testPrincipal, threadId });
    await stream.open({ ws: second, principal: testPrincipal, threadId });
    expect(first.closed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    stream.evictStaleSubscribers();
    expect(second.closed).toBe(true);

    await stream.open({ ws: dead, principal: testPrincipal, threadId });
    await threads.abortThread(testPrincipal, threadId, "req_abort_dead_sender");
    expect(stream.activeSubscriberCount()).toBe(0);
  });

  it("drains subscribers on shutdown", async () => {
    const { stream, threadId } = await createHarness();
    const ws = socket();

    await stream.open({ ws, principal: testPrincipal, threadId });
    stream.shutdown();

    expect(ws.sent.at(-1)).toEqual({
      type: "thread.stream.closing",
      reason: "server_shutdown",
    });
    expect(ws.closed).toBe(true);
    expect(stream.activeSubscriberCount()).toBe(0);
  });

  it("closes a pending attach if shutdown races with replay loading", async () => {
    const { threads, threadId } = await createHarness();
    let releaseReplay!: () => void;
    const replayReady = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const delayedThreads: CodingAgentThreadStore = {
      ...threads,
      async getThread(principal, requestedThreadId, cursor) {
        await replayReady;
        return threads.getThread(principal, requestedThreadId, cursor);
      },
    };
    const stream = createCodingAgentThreadStream({ threads: delayedThreads });
    const ws = socket();

    const opened = stream.open({ ws, principal: testPrincipal, threadId });
    stream.shutdown();
    releaseReplay();
    await opened;

    expect(ws.sent.at(-1)).toEqual({
      type: "thread.stream.closing",
      reason: "server_shutdown",
    });
    expect(ws.closed).toBe(true);
    expect(stream.activeSubscriberCount()).toBe(0);
  });

  it("rejects extra stream sink registrations instead of detaching existing streams silently", async () => {
    const { threads } = await createHarness();

    for (let index = 0; index < 7; index += 1) {
      createCodingAgentThreadStream({ threads });
    }

    expect(() => createCodingAgentThreadStream({ threads })).toThrow(CodingAgentThreadError);
  });

  it("allows coding-agent thread WebSocket query-token auth through the shared middleware", async () => {
    const next = async () => undefined;
    const calls: string[] = [];
    const middleware = authMiddleware("secret-token");
    const makeContext = (path: string, token?: string) => ({
      req: {
        path,
        url: `http://localhost${path}${token ? `?token=${token}` : ""}`,
        header: () => undefined,
      },
      json: (body: unknown, status: number) => ({ body, status }),
      set: () => undefined,
    });

    await middleware(makeContext("/ws/coding-agents/thread/thread_abc", "secret-token") as never, async () => {
      calls.push("ok");
      return next();
    });
    const rejected = await middleware(
      makeContext("/ws/coding-agents/thread/thread_abc", "wrong-token") as never,
      async () => next(),
    );

    expect(calls).toEqual(["ok"]);
    expect(rejected).toEqual({ body: { error: "Unauthorized" }, status: 401 });
  });
});
