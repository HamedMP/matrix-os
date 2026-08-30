import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  createCanonicalChatEventStream,
  type CanonicalChatEventRepository,
  type CanonicalChatEventStreamSocket,
} from "../../packages/gateway/src/chat/event-stream.js";
import { closeCanonicalChatEventLifecycle, registerCanonicalChatEventRoute } from "../../packages/gateway/src/chat/routes.js";
import type { ChatOutboxEvent, ChatOwner } from "../../packages/gateway/src/chat/records.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principalA: RequestPrincipal = { userId: "owner_a", source: "jwt" };
const principalB: RequestPrincipal = { userId: "owner_b", source: "jwt" };

function outbox(cursor: number, chatId = "chat_event_a", overrides = {}): ChatOutboxEvent {
  return {
    cursor, chatId, revision: cursor, eventType: "chat.updated", payload: {},
    createdAt: `2026-08-29T00:00:${String(cursor).padStart(2, "0")}.000Z`, ...overrides,
  };
}

function socket(onClose?: () => void) {
  return {
    sent: [] as unknown[], closed: false, failSend: false,
    send(data: string) {
      if (this.failSend) throw new Error("send failed");
      this.sent.push(JSON.parse(data));
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

function eventCursors(ws: ReturnType<typeof socket>) {
  return ws.sent.filter((frame) => (frame as { type: string }).type === "chat.event")
    .map((frame) => (frame as { event: { cursor: number } }).event.cursor);
}

describe("canonical Chat event stream", () => {
  it("subscribes before replay, buffers live commits, dedupes the overlap, and publishes safe metadata only", async () => {
    const replay = deferred<{ events: ChatOutboxEvent[]; gap: boolean; nextCursor?: number }>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const ws = socket();
    const opening = stream.open({ ws, principal: principalA, cursor: 0 });
    harness.publish("owner_a", outbox(2, "chat_event_a", {
      payload: { transcript: "private transcript", provider: "provider-secret", path: "/home/private" },
    }));
    harness.publish("owner_a", outbox(3, "chat_event_b"));
    replay.resolve({ events: [outbox(1), outbox(2)], gap: false, nextCursor: 2 });
    await opening;
    expect(ws.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "chat.stream.attached", "chat.event", "chat.event", "chat.replay.end", "chat.event",
    ]);
    expect(eventCursors(ws)).toEqual([1, 2, 3]);
    expect(JSON.stringify(ws.sent)).not.toMatch(/private transcript|provider-secret|home\/private|payload/);
  });

  it("does not skip an unseen lower cursor that commits after a higher cursor", async () => {
    const harness = repositoryHarness();
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const ws = socket();
    await stream.open({ ws, principal: principalA, cursor: 3 });
    for (const cursor of [5, 4, 5]) harness.publish("owner_a", outbox(cursor));
    expect(eventCursors(ws)).toEqual([5, 4]);
  });

  it("isolates owners and emits an explicit full-refresh signal for a missing or pruned cursor", async () => {
    const harness = repositoryHarness(async (owner) => owner.ownerId === "owner_a"
      ? { events: [], gap: true }
      : { events: [outbox(8, "chat_owner_b")], gap: false, nextCursor: 8 });
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const [a, b] = [socket(), socket()];
    await stream.open({ ws: a, principal: principalA, cursor: 2 });
    await stream.open({ ws: b, principal: principalB, cursor: 7 });
    harness.publish("owner_b", outbox(9, "chat_owner_b"));
    expect(a.sent).toContainEqual({ type: "chat.replay.gap", reason: "cursor_unavailable" });
    expect(eventCursors(a)).toEqual([]);
    expect(eventCursors(b)).toEqual([8, 9]);
  });

  it("bounds attach buffering and inbound frames, and validates ping and detach", async () => {
    const replay = deferred<{ events: ChatOutboxEvent[]; gap: boolean }>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createCanonicalChatEventStream({ repository: harness.repository, maxAttachBuffer: 2 });
    const overflow = socket();
    const opening = stream.open({ ws: overflow, principal: principalA });
    for (const cursor of [1, 2, 3]) harness.publish("owner_a", outbox(cursor));
    replay.resolve({ events: [], gap: false });
    await opening;
    expect(overflow.closed).toBe(true);

    const validHarness = repositoryHarness();
    const validStream = createCanonicalChatEventStream({ repository: validHarness.repository });
    const invalid = socket();
    (await validStream.open({ ws: invalid, principal: principalA })).onMessage("x".repeat(4097));
    expect(invalid.sent).toContainEqual(expect.objectContaining({
      type: "chat.stream.error", error: expect.objectContaining({ code: "invalid_frame" }),
    }));
    const ping = socket();
    const session = await validStream.open({ ws: ping, principal: principalB });
    session.onMessage(JSON.stringify({ type: "ping", unexpected: true }));
    session.onMessage(JSON.stringify({ type: "ping" }));
    expect(ping.sent).toContainEqual({ type: "pong" });
    session.onMessage(JSON.stringify({ type: "detach" }));
    expect(ping.closed).toBe(true);
  });

  it("reports unexpected JSON parser failures without exposing the raw error", async () => {
    const harness = repositoryHarness();
    const stream = createCanonicalChatEventStream({ repository: harness.repository });
    const ws = socket();
    const session = await stream.open({ ws, principal: principalA });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw new TypeError("sensitive detail"); });
    expect(() => session.onMessage('{"type":"ping"}')).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[chat/event-stream] JSON parse failed:", "TypeError");
    expect(JSON.stringify(ws.sent)).not.toContain("sensitive detail");
    expect(ws.sent).toContainEqual(expect.objectContaining({
      type: "chat.stream.error", error: expect.objectContaining({ code: "invalid_frame" }),
    }));
  });

  it("enforces global and per-owner caps, TTL eviction, failed-sender removal, and close cleanup", async () => {
    let now = 0;
    const harness = repositoryHarness();
    const stream = createCanonicalChatEventStream({
      repository: harness.repository, maxSubscribers: 2, maxSubscribersPerOwner: 1,
      subscriberTtlMs: 10, now: () => now,
    });
    const [firstA, secondA, ownerB] = [socket(), socket(), socket()];
    await stream.open({ ws: firstA, principal: principalA });
    now = 1;
    await stream.open({ ws: secondA, principal: principalA });
    expect(firstA.closed).toBe(true);
    await stream.open({ ws: ownerB, principal: principalB });
    secondA.failSend = true;
    harness.publish("owner_a", outbox(10));
    expect(stream.activeSubscriberCount()).toBe(1);
    now = 20;
    stream.evictStaleSubscribers();
    expect(ownerB.closed).toBe(true);
    (await stream.open({ ws: socket(), principal: principalA })).onClose();
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
    const ws = socket(() => order.push("socket.close"));
    await stream.open({ ws, principal: principalA });
    stream.shutdown();
    expect(ws.sent.at(-1)).toEqual({ type: "chat.stream.closing", reason: "server_shutdown" });
    expect(stream.activeSubscriberCount()).toBe(0);
    expect(harness.disposed()).toBe(true);
    expect(order).toEqual(["socket.close", "sink.dispose"]);
  });

  it("drains the Chat stream before releasing the shared repository through the public close seam", async () => {
    const order: string[] = [];
    await closeCanonicalChatEventLifecycle({
      stream: { shutdown: () => { order.push("stream.shutdown"); } },
      releaseRepository: async () => { order.push("repository.release"); },
    });
    expect(order).toEqual(["stream.shutdown", "repository.release"]);
  });

  it("allows query-token auth only for the exact Chat WebSocket path", async () => {
    const middleware = authMiddleware("secret-token");
    const calls: string[] = [];
    const context = (path: string) => ({
      req: { path, url: `http://localhost${path}?token=secret-token`, header: () => undefined },
      json: (body: unknown, status: number) => ({ body, status }), set: () => undefined,
    });
    await middleware(context("/ws/chats/events") as never, async () => { calls.push("ws"); });
    const rest = await middleware(context("/api/chats") as never, async () => { calls.push("rest"); });
    expect(calls).toEqual(["ws"]);
    expect(rest).toEqual({ body: { error: "Unauthorized" }, status: 401 });
  });

  it("registers the exact owner route and passes only the verified principal into the stream", async () => {
    const context = { requestId: "verified" };
    const ws = socket();
    const open = vi.fn(async () => ({ onMessage: () => undefined, onClose: () => undefined }));
    const getPrincipal = vi.fn(() => principalA);
    let path: string | undefined;
    let routeOpen: ((input: { context: unknown; ws: CanonicalChatEventStreamSocket; cursor?: string }) => Promise<void>) | undefined;
    registerCanonicalChatEventRoute({ mount(nextPath, handler) { path = nextPath; routeOpen = handler; }, getPrincipal, stream: { open } });
    await routeOpen?.({ context, ws, cursor: "12" });
    expect(path).toBe("/ws/chats/events");
    expect(getPrincipal).toHaveBeenCalledWith(context);
    expect(open).toHaveBeenCalledWith({ ws, principal: principalA, cursor: 12 });
  });
});
