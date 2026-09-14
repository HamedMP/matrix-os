import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { type PlatformDB, insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

describe("Chat SSE through authenticated platform routing", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    db = await setupProxyRoutingTest();
    await insertUserMachine(db, {
      machineId: "machine-chat-stream", clerkUserId: "user_alice", handle: "alice-review",
      runtimeSlot: "review", status: "running", hetznerServerId: 100,
      publicIPv4: "203.0.113.21", imageVersion: "dev", serverType: "cpx22",
      provisionedAt: "2026-07-16T00:00:00.000Z",
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await cleanupProxyRoutingTest(db);
  });

  it.each([
    ["/api/chats/events?runtime=review", "GET", true],
    ["/vm/alice-review/api/chats/events", "GET", true],
    ["/api/chats?runtime=review", "GET", false],
    ["/api/chats/events?runtime=review", "POST", false],
  ] as const)("applies the correct body deadline to %s (%s)", async (path, method, streaming) => {
    const app = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123",
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }) }),
    });
    vi.useFakeTimers();
    // Native AbortSignal.timeout does not use Vitest's clock. Keep its actual
    // cancellation semantics while making the 30-second boundary deterministic.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(
      new ReadableStream({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('data: {"checkpoint":"after-30s"}\n\n'));
            controller.close();
          }, 35_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            controller.error(init.signal?.reason);
          }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } },
    ));
    const response = await app.request(path, {
      method,
      headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-session", accept: "text/event-stream", "x-matrix-chat-protocol": "2" },
    });
    expect(response.status).toBe(200);
    const body = response.text().then(text => ({ text }), error => ({ error: String(error) }));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await body).toEqual(streaming
      ? { text: 'data: {"checkpoint":"after-30s"}\n\n' }
      : { error: "TimeoutError: Timed out" });
  });
});
