import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatStreamServerFrame } from "@matrix-os/contracts";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  createCanonicalChatEventStream,
  type CanonicalChatEventRepository,
} from "../../packages/gateway/src/chat/event-stream.js";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import { closeCanonicalChatEventLifecycle } from "../../packages/gateway/src/chat/routes.js";
import type { ChatOutboxEvent, ChatOwner } from "../../packages/gateway/src/chat/records.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principalA: RequestPrincipal = { userId: "owner_a", source: "jwt" };
const principalB: RequestPrincipal = { userId: "owner_b", source: "jwt" };

function outbox(cursor: number, chatId = "chat_event_a", overrides = {}): ChatOutboxEvent {
  return {
    cursor, chatId, revision: cursor, eventType: "chat.updated", payload: {},
    createdAt: "2026-08-29T00:00:00.000Z", ...overrides,
  };
}

function frameSink(onClose?: () => void) {
  return {
    sent: [] as CanonicalChatStreamServerFrame[], closed: false, failSend: false,
    send(frame: CanonicalChatStreamServerFrame) {
      if (this.failSend) return false;
      this.sent.push(frame);
      return true;
    },
    close() { this.closed = true; onClose?.(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function repositoryHarness(
  replay: CanonicalChatEventRepository["replayOutboxWindow"] = async () => ({ events: [], gap: false }),
) {
  let sink: ((input: { owner: ChatOwner; event: ChatOutboxEvent }) => void) | undefined;
  let disposed = false;
  const repository: CanonicalChatEventRepository = {
    replayOutboxWindow: vi.fn(replay),
    registerOutboxSink(next) {
      if (sink) throw new Error("outbox sink already registered");
      sink = next;
      return { dispose: () => { disposed = true; sink = undefined; } };
    },
  };
  return {
    repository,
    publish(ownerId: string, event: ChatOutboxEvent) {
      sink?.({ owner: { type: "personal", ownerId }, event });
    },
    disposed: () => disposed,
  };
}

function eventCursors(sink: ReturnType<typeof frameSink>) {
  return sink.sent.filter((frame) => frame.type === "chat.event")
    .map((frame) => frame.type === "chat.event" ? frame.event.cursor : -1);
}

describe("canonical Chat event stream", () => {
  it("subscribes before replay, buffers live commits, dedupes the overlap, and publishes safe metadata only", async () => {
    const replay = deferred<{ events: ChatOutboxEvent[]; gap: boolean; nextCursor?: number }>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const sink = frameSink();
    const opening = stream.open({ sink, principal: principalA, cursor: 0 });
    harness.publish("owner_a", outbox(2, "chat_event_a", {
      payload: { transcript: "private transcript", provider: "provider-secret", path: "/home/private" },
    }));
    harness.publish("owner_a", outbox(3, "chat_event_b"));
    replay.resolve({ events: [outbox(1), outbox(2)], gap: false, nextCursor: 2 });
    await opening;
    expect(sink.sent.map((frame) => frame.type)).toEqual([
      "chat.stream.attached", "chat.event", "chat.event", "chat.replay.end", "chat.event",
    ]);
    expect(eventCursors(sink)).toEqual([1, 2, 3]);
    expect(JSON.stringify(sink.sent)).not.toMatch(/private transcript|provider-secret|home\/private|payload/);
  });

  it("does not skip an unseen lower cursor that commits after a higher cursor", async () => {
    const harness = repositoryHarness();
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const sink = frameSink();
    await stream.open({ sink, principal: principalA, cursor: 3 });
    for (const cursor of [5, 4, 5]) harness.publish("owner_a", outbox(cursor));
    expect(eventCursors(sink)).toEqual([5, 4]);
  });

  it("derives the replay checkpoint when the repository omits nextCursor", async () => {
    const harness = repositoryHarness(async () => ({ events: [outbox(7)], gap: false }));
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const sink = frameSink();
    await stream.open({ sink, principal: principalA });
    expect(sink.sent).toContainEqual({ type: "chat.replay.end", nextCursor: 7 });
  });

  it("isolates owners and emits an explicit full-refresh signal for a missing or pruned cursor", async () => {
    const harness = repositoryHarness(async (owner) => owner.ownerId === "owner_a"
      ? { events: [], gap: true }
      : { events: [outbox(8, "chat_owner_b")], gap: false, nextCursor: 8 });
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const [a, b] = [frameSink(), frameSink()];
    await stream.open({ sink: a, principal: principalA, cursor: 2 });
    await stream.open({ sink: b, principal: principalB, cursor: 7 });
    harness.publish("owner_b", outbox(9, "chat_owner_b"));
    expect(a.sent).toContainEqual({ type: "chat.replay.gap", reason: "cursor_unavailable" });
    expect(eventCursors(a)).toEqual([]);
    expect(eventCursors(b)).toEqual([8, 9]);
  });

  it("bounds attach buffering and renews the subscriber lease through the transport session", async () => {
    const replay = deferred<{ events: ChatOutboxEvent[]; gap: boolean }>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createCanonicalChatEventStream({ repository: harness.repository, maxAttachBuffer: 2 });
    const overflow = frameSink();
    const opening = stream.open({ sink: overflow, principal: principalA });
    for (const cursor of [1, 2, 3]) harness.publish("owner_a", outbox(cursor));
    replay.resolve({ events: [], gap: false });
    await opening;
    expect(overflow.closed).toBe(true);

    let now = 0;
    const validHarness = repositoryHarness();
    const validStream = createCanonicalChatEventStream({
      repository: validHarness.repository,
      subscriberTtlMs: 10,
      now: () => now,
    });
    const active = frameSink();
    const session = await validStream.open({ sink: active, principal: principalB });
    now = 9;
    session.touch();
    now = 15;
    validStream.evictStaleSubscribers();
    expect(active.closed).toBe(false);
    now = 20;
    validStream.evictStaleSubscribers();
    expect(active.closed).toBe(true);
  });

  it("enforces global and per-owner caps, TTL eviction, failed-sender removal, and close cleanup", async () => {
    let now = 0;
    const harness = repositoryHarness();
    const stream = createCanonicalChatEventStream({
      repository: harness.repository, maxSubscribers: 2, maxSubscribersPerOwner: 1,
      subscriberTtlMs: 10, now: () => now,
    });
    const [firstA, secondA, ownerB] = [frameSink(), frameSink(), frameSink()];
    await stream.open({ sink: firstA, principal: principalA });
    now = 1;
    await stream.open({ sink: secondA, principal: principalA });
    expect(firstA.closed).toBe(true);
    await stream.open({ sink: ownerB, principal: principalB });
    secondA.failSend = true;
    harness.publish("owner_a", outbox(10));
    expect(stream.activeSubscriberCount()).toBe(1);
    now = 20;
    stream.evictStaleSubscribers();
    expect(ownerB.closed).toBe(true);
    (await stream.open({ sink: frameSink(), principal: principalA })).onClose();
    expect(stream.activeSubscriberCount()).toBe(0);
  });

  it("closes and drains every subscriber and the repository sink on shutdown", async () => {
    const order: string[] = [];
    const harness = repositoryHarness();
    const register = harness.repository.registerOutboxSink;
    harness.repository.registerOutboxSink = (sink) => {
      const registration = register(sink);
      return { dispose: () => { order.push("sink.dispose"); registration.dispose(); } };
    };
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const responseSink = frameSink(() => order.push("sink.close"));
    await stream.open({ sink: responseSink, principal: principalA });
    stream.shutdown();
    expect(responseSink.sent.at(-1)).toEqual({ type: "chat.stream.closing", reason: "server_shutdown" });
    expect(stream.activeSubscriberCount()).toBe(0);
    expect(harness.disposed()).toBe(true);
    expect(order).toEqual(["sink.close", "sink.dispose"]);
  });

  it("drains the Chat stream before releasing the shared repository through the public close seam", async () => {
    const order: string[] = [];
    await closeCanonicalChatEventLifecycle({
      stream: { shutdown: () => { order.push("stream.shutdown"); } },
      releaseRepository: async () => { order.push("repository.release"); },
    });
    expect(order).toEqual(["stream.shutdown", "repository.release"]);
  });

  it("rejects the removed Chat WebSocket query-token path", async () => {
    const middleware = authMiddleware("secret-token");
    const calls: string[] = [];
    const context = (path: string) => ({
      req: { path, url: `http://localhost${path}?token=secret-token`, header: () => undefined },
      json: (body: unknown, status: number) => ({ body, status }), set: () => undefined,
    });
    const removed = await middleware(context("/ws/chats/events") as never, async () => { calls.push("ws"); });
    const rest = await middleware(context("/api/chats") as never, async () => { calls.push("rest"); });
    expect(calls).toEqual([]);
    expect(removed).toEqual({ body: { error: "Unauthorized" }, status: 401 });
    expect(rest).toEqual({ body: { error: "Unauthorized" }, status: 401 });
  });

  it("streams bounded SSE frames for the verified principal and prefers Last-Event-ID", async () => {
    const app = new Hono();
    const onClose = vi.fn();
    const touch = vi.fn();
    const open = vi.fn(async ({ sink }: Parameters<Parameters<typeof registerCanonicalChatEventHttpRoute>[0]["stream"]["open"]>[0]) => {
      sink.send({ type: "chat.stream.attached" });
      sink.send({
        type: "chat.event",
        event: {
          cursor: 13,
          chatId: "chat_event_http",
          revision: 13,
          eventType: "run.message",
          createdAt: "2026-08-29T00:00:13.000Z",
        },
      });
      return { touch, onClose };
    });
    registerCanonicalChatEventHttpRoute({
      app,
      stream: { open },
      getPrincipal: () => principalA,
    });

    const response = await app.request("/api/chats/events?cursor=7", {
      headers: { accept: "text/event-stream", "last-event-id": "12" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ principal: principalA, cursor: 12 }));

    const reader = response.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      const second = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('data: {"type":"chat.stream.attached"}');
      expect(second).toContain("id: 13");
      expect(second).toContain('"chatId":"chat_event_http"');
    } finally {
      await reader.cancel();
    }
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects invalid event-stream requests before attaching", async () => {
    const app = new Hono();
    const open = vi.fn();
    registerCanonicalChatEventHttpRoute({ app, stream: { open }, getPrincipal: () => principalA });

    expect((await app.request("/api/chats/events", { headers: { accept: "application/json" } })).status).toBe(406);
    expect((await app.request("/api/chats/events?cursor=-1", { headers: { accept: "text/event-stream" } })).status).toBe(400);
    expect((await app.request("/api/chats/events", {
      headers: { accept: "text/event-stream", "last-event-id": "not-a-cursor" },
    })).status).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it("uses SSE comments to renew the subscriber lease and cleans up on cancellation", async () => {
    const app = new Hono();
    const touch = vi.fn();
    const onClose = vi.fn();
    let heartbeat: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    registerCanonicalChatEventHttpRoute({
      app,
      stream: { open: async () => ({ touch, onClose }) },
      getPrincipal: () => principalA,
      heartbeatIntervalMs: 1_000,
      setIntervalFn(callback) {
        heartbeat = callback;
        return "heartbeat-timer";
      },
      clearIntervalFn,
    });

    const response = await app.request("/api/chats/events", { headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    await vi.waitFor(() => expect(heartbeat).toBeTypeOf("function"));
    heartbeat?.();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    expect(touch).toHaveBeenCalledOnce();
    await reader.cancel();
    expect(onClose).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith("heartbeat-timer");
  });

  it("returns the HTTP response before replay finishes", async () => {
    const replay = deferred<{ events: ChatOutboxEvent[]; gap: boolean }>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const app = new Hono();
    registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principalA });

    const request = Promise.resolve(app.request("/api/chats/events", { headers: { accept: "text/event-stream" } }));
    const outcome = await Promise.race([
      request.then((response) => ({ type: "response" as const, response })),
      new Promise<{ type: "timeout" }>((resolve) => setTimeout(() => resolve({ type: "timeout" }), 25)),
    ]);
    expect(outcome.type).toBe("response");
    replay.resolve({ events: [], gap: false });
    const response = await request;
    await response.body?.cancel();
  });

  it("keeps a bounded initial replay attached while the client starts reading", async () => {
    const harness = repositoryHarness(async () => ({
      events: Array.from({ length: 12 }, (_, index) => outbox(index + 1)),
      gap: false,
      nextCursor: 12,
    }));
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const app = new Hono();
    registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principalA });

    const response = await app.request("/api/chats/events", { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(stream.activeSubscriberCount()).toBe(1));
    const reader = response.body!.getReader();
    for (let index = 0; index < 14; index += 1) {
      expect((await reader.read()).done).toBe(false);
    }
    await reader.cancel();
    expect(stream.activeSubscriberCount()).toBe(0);
  });

  it("fits the maximum replay and attach buffer within the bounded response queue", async () => {
    const replay = deferred<{ events: ChatOutboxEvent[]; gap: boolean; nextCursor: number }>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const app = new Hono();
    registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principalA });

    const response = await app.request("/api/chats/events", { headers: { accept: "text/event-stream" } });
    await vi.waitFor(() => expect(stream.activeSubscriberCount()).toBe(1));
    for (let cursor = 101; cursor <= 300; cursor += 1) {
      harness.publish("owner_a", outbox(cursor));
    }
    replay.resolve({
      events: Array.from({ length: 100 }, (_, index) => outbox(index + 1)),
      gap: false,
      nextCursor: 100,
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(stream.activeSubscriberCount()).toBe(1);
    await response.body?.cancel();
  });

  it("evicts a genuinely slow HTTP response instead of growing its live queue", async () => {
    const harness = repositoryHarness();
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const app = new Hono();
    registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => principalA });

    const response = await app.request("/api/chats/events", { headers: { accept: "text/event-stream" } });
    await vi.waitFor(() => expect(stream.activeSubscriberCount()).toBe(1));
    for (let cursor = 1; cursor <= 400; cursor += 1) {
      harness.publish("owner_a", outbox(cursor));
    }
    expect(stream.activeSubscriberCount()).toBe(0);
    await response.body?.cancel();
  });
});
