import { lstat, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBotBridgeFetch } from "../../packages/bot-runtime/src/bridge-fetch.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { ScopeRuntimeBotInferenceRequestSchema } from "../../packages/scope-runtime/src/broker-protocol.js";
import { brokerRequest, inferenceActionForPath, startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

// Independent transport contract: raw UTF-8 and its JSON envelope are different budgets.
const BODY_MAX_BYTES = 1_048_576;
const FRAME_MAX_BYTES = 6 * BODY_MAX_BYTES + 4_096;
const MODEL = "inference-capacity-fixture";
const RUNTIME = `runtime_${"c".repeat(32)}`;
const requestBody = JSON.stringify({ model: MODEL, store: false, stream: true,
  input: [{ role: "user", content: "Offline Unix response-capacity fixture." }] });
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error: unknown) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Unix response fixture cleanup failed");
});

function completedSse(bytes: number, padding: "x" | "\u0000" = "x"): string {
  const output = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "CAPACITY_OK", annotations: [] }] };
  const events = [
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "CAPACITY_OK" },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", model: MODEL,
      output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  // An SSE comment carries no model content; NUL bytes exercise JSON's six-byte escaping.
  const fixed = `:\n\n${events}`;
  return `:${padding.repeat(bytes - Buffer.byteLength(fixed))}\n\n${events}`;
}

function success(requestId: string, body: string) {
  return { version: 1, requestId, ok: true, status: 200,
    headers: { "content-type": "text/event-stream" }, body };
}

async function bridgeFor(brokerSocket: string, directory: string) {
  const socketPath = join(directory, "inference.sock");
  const bridge = await startInferenceBridge({ brokerSocket, socketPath, botImages: true,
    runtimeHandle: RUNTIME, executionGeneration: "3", brokerTimeoutMs: 5_000,
    actionFor: request => inferenceActionForPath(request.url) });
  cleanups.push(async () => {
    await bridge.close();
    expect(bridge.server.listening).toBe(false);
  });
  const fetch = createBotBridgeFetch(socketPath);
  return () => fetch("http://127.0.0.1/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" }, body: requestBody,
    signal: AbortSignal.timeout(5_000) });
}

async function productionChain(body: string) {
  const directory = await createUnixSocketTempDir();
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const brokerSocket = join(directory, "broker.sock");
  let requests = 0;
  let serializedReplyBytes = 0;
  const broker = createScopeRuntimeBrokerServer({ socketPath: brokerSocket,
    broker: { handle: async () => { throw new Error("The bot inference route must own this request"); }, close: async () => undefined },
    routeFrame: async raw => {
      const frame = ScopeRuntimeBotInferenceRequestSchema.parse(raw);
      expect(frame).toMatchObject({ action: "inference.responses", path: "/v1/responses", method: "POST",
        runtimeHandle: RUNTIME, executionGeneration: "3", headers: {} });
      expect(frame.body).toBe(requestBody);
      requests++;
      const reply = success(frame.requestId, body);
      serializedReplyBytes = Buffer.byteLength(`${JSON.stringify(reply)}\n`);
      return reply;
    },
  });
  await broker.start();
  cleanups.push(async () => {
    await broker.close();
    await expect(lstat(brokerSocket)).rejects.toMatchObject({ code: "ENOENT" });
  });
  return { request: await bridgeFor(brokerSocket, directory),
    requests: () => requests, serializedReplyBytes: () => serializedReplyBytes };
}

async function readSuccess(request: () => Promise<Response>): Promise<Buffer> {
  const response = await request();
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Inference bridge returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

describe("inference response capacity through real Unix sockets", () => {
  it("retains a small completed response through the production broker writer and private fetch", async () => {
    const body = completedSse(4_096);
    const chain = await productionChain(body);
    expect(await readSuccess(chain.request)).toEqual(Buffer.from(body));
    expect(chain.requests()).toBe(1);
  });

  it("preserves a legal raw response below one MiB whose escaped JSON frame exceeds one MiB", async () => {
    const body = completedSse(384 * 1_024, "\u0000");
    const chain = await productionChain(body);
    const received = await readSuccess(chain.request);
    expect(chain.serializedReplyBytes()).toBeGreaterThan(BODY_MAX_BYTES);
    expect(chain.serializedReplyBytes()).toBeLessThan(FRAME_MAX_BYTES);
    expect(received).toEqual(Buffer.from(body));
    expect(chain.requests()).toBe(1);
  });

  it("allows exactly one MiB of raw response bytes without counting JSON escaping twice", async () => {
    const body = completedSse(BODY_MAX_BYTES, "\u0000");
    expect(Buffer.byteLength(body)).toBe(BODY_MAX_BYTES);
    const chain = await productionChain(body);
    expect(await readSuccess(chain.request)).toEqual(Buffer.from(body));
    expect(chain.serializedReplyBytes()).toBeLessThanOrEqual(FRAME_MAX_BYTES);
    expect(chain.requests()).toBe(1);
  });

  it("refuses one byte over the raw body limit and still drains the Unix bridge", async () => {
    const body = completedSse(BODY_MAX_BYTES + 1);
    const chain = await productionChain(body);
    await expect(readSuccess(chain.request)).rejects.toThrow();
    expect(chain.requests()).toBe(1);
  });

  it("rejects an over-budget unterminated broker frame before EOF and drains its fixture sockets", async () => {
    const directory = await createUnixSocketTempDir();
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const brokerSocket = join(directory, "adversarial.sock");
    const sockets = new Set<Socket>(); // At most two half-open observations; explicit shutdown drains both.
    let requestCount = 0;
    let responseEofs = 0;
    const server: Server = createServer({ allowHalfOpen: true }, socket => {
      if (sockets.size >= 2) { socket.destroy(); return; }
      sockets.add(socket);
      let input = "";
      let sent = false;
      socket.on("data", chunk => {
        input += chunk.toString("utf8");
        if (input.length > 4_096) { socket.destroy(); return; }
        if (!sent && input.includes('\n')) send();
      });
      socket.once("error", error => { expect(["EPIPE", "ECONNRESET"]).toContain((error as NodeJS.ErrnoException).code); });
      socket.once("close", () => sockets.delete(socket));
      socket.once("finish", () => { responseEofs++; });
      function send() {
        if (sent) return;
        sent = true;
        ScopeRuntimeBotInferenceRequestSchema.parse(JSON.parse(input));
        requestCount++;
        // No newline/EOF: only the frame budget, rather than parsing or idle timeout, can settle this.
        socket.write(Buffer.alloc(FRAME_MAX_BYTES + 1, "x"));
      }
      socket.once('end', send);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(brokerSocket, resolve); });
    cleanups.push(async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      const drained = [...sockets].map(socket => new Promise<void>(resolve => {
        socket.once("close", () => resolve());
        socket.destroy();
      }));
      await Promise.all(drained);
      await closed;
      expect(sockets.size).toBe(0);
      expect(server.listening).toBe(false);
    });
    const request = await bridgeFor(brokerSocket, directory);
    const started = performance.now();
    const response = await request();
    expect(response.status).toBe(502);
    await response.arrayBuffer();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(requestCount).toBe(1);
    expect(responseEofs).toBe(0);

    const directStarted = performance.now();
    await expect(brokerRequest(brokerSocket, { version: 1, action: "inference.responses",
      requestId: "10000000-0000-4000-8000-000000000001", runtimeHandle: RUNTIME,
      executionGeneration: "3", method: "POST", path: "/v1/responses", headers: {}, body: requestBody },
    undefined, 5_000)).rejects.toMatchObject({ name: "ScopeRuntimeBrokerError", message: "Broker response exceeded capacity" });
    expect(performance.now() - directStarted).toBeLessThan(2_000);
    expect(requestCount).toBe(2);
    expect(responseEofs).toBe(0);
  });
});
