import { createServer as createHttpServer } from "node:http";
import { createServer as createBrokerServer, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotBridgeFetch } from "../../packages/bot-runtime/src/bridge-fetch.js";
import { inferenceActionForPath, startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const WAIT_MS = 11 * 60_000;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Node's native AbortSignal.timeout uses an internal clock. Drive the old
  // absolute deadline with the same clock as the replacement idle watchdog.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(layer: "worker" | "broker", streamed = true) {
  const directory = await createUnixSocketTempDir();
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "http.sock");
  let connected!: () => void;
  const accepted = new Promise<void>(resolve => { connected = resolve; });
  let headers!: () => void;
  let write!: (body: string) => void;
  let end!: () => void;
  let closed = false;
  if (layer === "worker") {
    const server = createHttpServer((_request, response) => {
      response.once("close", () => { closed = true; });
      headers = () => {
        response.writeHead(200, { "content-type": "text/event-stream", ...(streamed ? { "x-matrix-inference-stream": "1" } : {}) });
        response.flushHeaders();
      };
      write = body => { response.write(body); };
      end = () => { response.end(); };
      connected();
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
  } else {
    const brokerSocket = join(directory, "broker.sock");
    const sockets = new Set<Socket>();
    const server = createBrokerServer(socket => {
      sockets.add(socket);
      socket.on("error", error => {
        if (!["EPIPE", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      });
      socket.once("close", () => { closed = true; sockets.delete(socket); });
      let input = "";
      socket.on("data", bytes => {
        input += bytes.toString("utf8");
        if (!input.includes("\n")) return;
        socket.removeAllListeners("data");
        const { requestId } = JSON.parse(input) as { requestId: string };
        let sequence = 0;
        const frame = (value: object) => { socket.write(`${JSON.stringify({ version: 1, requestId, ...value })}\n`); };
        headers = () => frame({ stream: "start", status: 200, headers: { "content-type": "text/event-stream" } });
        write = body => frame({ stream: "chunk", sequence: sequence++, body });
        end = () => { frame({ stream: "end", sequence }); socket.end(); };
        connected();
      });
    });
    await new Promise<void>(resolve => server.listen(brokerSocket, resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const bridge = await startInferenceBridge({ brokerSocket, socketPath, botImages: true,
      runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", brokerTimeoutMs: WAIT_MS,
      actionFor: request => inferenceActionForPath(request.url) });
    cleanups.push(() => bridge.close());
  }
  const fetch = createBotBridgeFetch(socketPath);
  const request = (signal?: AbortSignal) => {
    const result = fetch("http://127.0.0.1/v1/responses", { method: "POST", body: "{}", signal });
    void result.catch(() => undefined);
    return result;
  };
  return { request, accepted, headers: () => headers(), write: (body: string) => write(body), end: () => end(),
    get closed() { return closed; } };
}

describe.each(["worker", "broker"] as const)("%s inference progress deadline", layer => {
  it("keeps a progressing stream alive beyond eleven minutes total", async () => {
    const f = await fixture(layer);
    const pending = f.request();
    await f.accepted;
    f.headers(); f.write(":first\n\n");
    const reader = (await pending).body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe(":first\n\n");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    f.write(":second\n\n");
    expect(Buffer.from((await reader.read()).value!).toString()).toBe(":second\n\n");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    f.write(":last\n\n"); f.end();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe(":last\n\n");
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives stream start a fresh bounded wait for its first body bytes", async () => {
    const f = await fixture(layer);
    const pending = f.request();
    await f.accepted;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    f.headers();
    // Flush the start/header through the real socket before advancing time.
    await pending;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    f.write(":first\n\n"); f.end();
    expect(await (await pending).text()).toBe(":first\n\n");
  });

  it("still bounds setup before response headers", async () => {
    const f = await fixture(layer);
    let settled = false;
    const outcome = f.request().then(response => response.status, () => 502)
      .finally(() => { settled = true; });
    await f.accepted;
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(502);
  });

  it("bounds a stream whose first body bytes never arrive", async () => {
    const f = await fixture(layer);
    let settled = false;
    const pending = f.request();
    const outcome = pending.then(response => response.text());
    void outcome.then(() => { settled = true; }, () => { settled = true; });
    await f.accepted;
    f.headers();
    await pending;
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).rejects.toThrow();
  });

  it("times out eleven minutes after the latest body progress", async () => {
    const f = await fixture(layer);
    const pending = f.request();
    await f.accepted;
    f.headers(); f.write(":first\n\n");
    const reader = (await pending).body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    f.write(":second\n\n");
    await reader.read();
    let settled = false;
    const next = reader.read();
    void next.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).rejects.toThrow();
    await vi.waitFor(() => expect(f.closed).toBe(true));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves parent Stop during a progressing stream", async () => {
    const f = await fixture(layer);
    const stop = new AbortController();
    const pending = f.request(stop.signal);
    await f.accepted;
    f.headers(); f.write(":first\n\n");
    const reader = (await pending).body!.getReader();
    await reader.read();
    const next = reader.read();
    const rejected = expect(next).rejects.toThrow();
    stop.abort();
    await rejected;
    await vi.waitFor(() => expect(f.closed).toBe(true));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes both sockets and clears its watchdog when the body reader cancels", async () => {
    const f = await fixture(layer);
    const pending = f.request();
    await f.accepted;
    f.headers(); f.write(":first\n\n");
    const reader = (await pending).body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(f.closed).toBe(true));
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("keeps the absolute response deadline for non-streaming legacy HTTP replies", async () => {
  const f = await fixture("worker", false);
  const pending = f.request();
  await f.accepted;
  f.headers(); f.write("first");
  const reader = (await pending).body!.getReader();
  await reader.read();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  f.write("second");
  await reader.read();
  const next = reader.read();
  const rejected = expect(next).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
});
