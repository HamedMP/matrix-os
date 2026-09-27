import { request, type ClientRequest, type IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { type PlatformDB, insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { fetchRuntimeProxy } from "../../packages/platform/src/runtime-proxy-fetch.js";
import { cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

describe("runtime proxy downstream disconnect ownership diagnostic", () => {
  let db: PlatformDB;
  let server: Server;
  const clients: ClientRequest[] = [];
  const streams: ReadableStream<Uint8Array>[] = [];
  let active = 0;
  let cancelled = 0;
  let requestSignal: AbortSignal | undefined;

  function streamResponse() {
    active += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: diagnostic\n\n")); },
      cancel() { active -= 1; cancelled += 1; },
    });
    streams.push(stream);
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  function openClient(): Promise<IncomingMessage> {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing diagnostic listener");
    return new Promise((resolve, reject) => {
      const client = request({ hostname: "127.0.0.1", port: address.port,
        path: "/api/chats/events?runtime=review", headers: { host: "app.matrix-os.com",
          authorization: "Bearer synthetic-test", accept: "text/event-stream", "x-matrix-chat-protocol": "2" } }, resolve);
      clients.push(client);
      client.on("error", reject);
      client.end();
    });
  }

  beforeEach(async () => {
    active = 0; cancelled = 0; requestSignal = undefined;
    db = await setupProxyRoutingTest();
    await insertUserMachine(db, { machineId: "machine-disconnect-diagnostic", clerkUserId: "user_alice",
      handle: "alice-review", runtimeSlot: "review", status: "running", hetznerServerId: 100,
      publicIPv4: "203.0.113.21", imageVersion: "dev", serverType: "cpx22", provisionedAt: "2026-07-16T00:00:00.000Z" });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "synthetic-platform-secret",
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }) }) });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Fixtures never retain upstream resources after the bounded diagnostic.
    for (const stream of streams.splice(0)) if (!stream.locked) await stream.cancel();
    await cleanupProxyRoutingTest(db);
  });

  it("cancels the actual upstream response body when a connected HTTP client closes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return streamResponse();
    });
    const response = await openClient();
    await new Promise<void>(resolve => response.once("data", () => resolve()));
    response.destroy();
    await vi.waitFor(() => expect(cancelled).toBe(1), { timeout: 1_000 });
    expect(active).toBe(0);
  });

  it("keeps only one actual upstream body after the HTTP client replaces its stream", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => streamResponse());
    for (let index = 0; index < 3; index += 1) {
      const response = await openClient();
      await new Promise<void>(resolve => response.once("data", () => resolve()));
      expect(active).toBe(1);
      response.destroy();
      await vi.waitFor(() => expect(active).toBe(0), { timeout: 1_000 });
    }
    expect(cancelled).toBe(3);
  });

  it("aborts an upstream header wait when the actual HTTP client disconnects before headers", async () => {
    let release: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(resolve => { release = resolve; });
    });
    const clientResult = openClient().catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 1_000 });
    clients.at(-1)!.destroy();
    await clientResult;
    try {
      await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true), { timeout: 1_000 });
    } finally {
      release!(streamResponse());
    }
  });

  it("honors a supplied caller abort instead of replacing it with the header deadline signal", async () => {
    const caller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        caller.signal.addEventListener("abort", () => { if (!requestSignal?.aborted) resolve(streamResponse()); }, { once: true });
      });
    });
    const pending = fetchRuntimeProxy("https://runtime.invalid/api/chats/events", { method: "GET", signal: caller.signal }, 1_000, true);
    const outcome = pending.then(() => "resolved", () => "aborted");
    caller.abort();
    expect(await outcome).toBe("aborted");
  });
});
