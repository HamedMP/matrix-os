import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBotBridgeFetch } from "../../packages/bot-runtime/src/bridge-fetch.js";
import { inferenceActionForPath, startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const RUNTIME = `runtime_${"a".repeat(32)}`;
const requestBody = JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "Hello" }] });
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(reply: (socket: Socket, request: Record<string, unknown>) => Promise<void> | void, timeoutMs = 5_000) {
  const directory = await createUnixSocketTempDir();
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const brokerSocket = join(directory, "broker.sock");
  const sockets = new Set<Socket>();
  const unexpectedErrors: Error[] = [];
  const broker = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("end", () => socket.destroy());
    socket.on("error", error => {
      if (!["EPIPE", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) unexpectedErrors.push(error);
    });
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(input.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      socket.removeAllListeners("data");
      void Promise.resolve(reply(socket, request)).catch(error => socket.destroy(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(brokerSocket, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => broker.close(() => resolve()));
    expect(unexpectedErrors).toEqual([]);
  });
  const bridge = await startInferenceBridge({ brokerSocket, socketPath: join(directory, "http.sock"),
    runtimeHandle: RUNTIME, executionGeneration: "3", botImages: true, brokerTimeoutMs: timeoutMs,
    actionFor: request => inferenceActionForPath(request.url) });
  cleanups.push(() => bridge.close());
  const bridgeFetch = createBotBridgeFetch(join(directory, "http.sock"));
  return () => bridgeFetch("http://127.0.0.1/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: requestBody,
    signal: AbortSignal.timeout(5_000),
  });
}

it("streams a response beyond one MiB through broker, HTTP bridge and Bot fetch before its end frame", async () => {
  const body = Array.from({ length: 40 }, () => `:${"x".repeat(32_000)}\n\n`).join("");
  let releaseRest: () => void = () => undefined;
  const rest = new Promise<void>(resolve => { releaseRest = resolve; });
  let observedMode: unknown;
  const request = await fixture(async (socket, frame) => {
    observedMode = frame.responseMode;
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: body.slice(0, 32_003) })}\n`);
    await rest;
    for (let offset = 32_003, sequence = 1; offset < body.length; offset += 32_003, sequence++) {
      socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence,
        body: body.slice(offset, offset + 32_003) })}\n`);
    }
    socket.end(`${JSON.stringify({ version: 1, requestId, stream: "end", sequence: 40 })}\n`);
  });
  try {
    const response = await request();
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    releaseRest();
    const chunks = [Buffer.from(first.value ?? [])];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    const received = Buffer.concat(chunks);
    expect(received.length).toBe(Buffer.byteLength(body));
    expect(received.equals(Buffer.from(body))).toBe(true);
    expect(observedMode).toBe("stream");
  } finally {
    releaseRest();
  }
});

it.each(["wrong request", "out of order", "oversized chunk", "unterminated frame", "missing end"] as const)(
  "destroys a partial HTTP reply for a %s broker stream",
  async (fault) => {
    let brokerClosed = false;
    const request = await fixture((socket, frame) => {
      socket.once("close", () => { brokerClosed = true; });
      const requestId = frame.requestId;
      socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
        headers: { "content-type": "text/event-stream" } })}\n`);
      if (fault === "unterminated frame") {
        socket.write("x".repeat(6 * 64 * 1024 + 4_097));
        return;
      }
      if (fault === "missing end") {
        socket.end(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: "partial" })}\n`);
        return;
      }
      const chunk = { version: 1, requestId: fault === "wrong request" ? "10000000-0000-4000-8000-000000000001" : requestId,
        stream: "chunk", sequence: fault === "out of order" ? 1 : 0,
        body: fault === "oversized chunk" ? "x".repeat(64 * 1024 + 1) : "partial" };
      socket.end(`${JSON.stringify(chunk)}\n`);
    });
    await expect(request().then(response => response.text())).rejects.toThrow();
    await vi.waitFor(() => expect(brokerClosed).toBe(true));
  },
);

it.each(["duplicate end", "trailing bytes"] as const)(
  "rejects %s arriving after the end frame in a later broker write",
  async (fault) => {
    let releaseTail: () => void = () => undefined;
    const tail = new Promise<void>(resolve => { releaseTail = resolve; });
    const request = await fixture(async (socket, frame) => {
      const requestId = frame.requestId;
      socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
        headers: { "content-type": "text/event-stream" } })}\n`);
      socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ":partial\n\n" })}\n`);
      socket.write(`${JSON.stringify({ version: 1, requestId, stream: "end", sequence: 1 })}\n`);
      await tail;
      socket.end(fault === "duplicate end"
        ? `${JSON.stringify({ version: 1, requestId, stream: "end", sequence: 1 })}\n`
        : "unexpected trailing bytes");
    });
    try {
      const response = await request();
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value ?? []).toString("utf8")).toBe(":partial\n\n");
      const completion = reader.read();
      releaseTail();
      await expect(completion).rejects.toThrow();
    } finally {
      releaseTail();
    }
  },
);

it.each([
  ["Responses completed", 'event: response.completed\ndata: {"type":"response.completed"}\n\n'],
  ["Responses done", "data: [DONE]\n\n"],
  ["Anthropic message stop", 'event: message_stop\ndata: {"type":"message_stop"}\n\n'],
  ["chat completion finish", 'data: {"choices":[{"finish_reason":"stop"}]}\n\n'],
] as const)("withholds %s until a valid broker end and EOF", async (_kind, terminal) => {
  const ordinary = 'data: {"type":"response.output_text.delta","delta":"hello"}\n\n';
  const request = await fixture((socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    socket.end(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 1, body: terminal })}\n`);
  });
  const response = await request();
  const reader = response.body!.getReader();
  let visible = "";
  await expect((async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      visible += Buffer.from(next.value).toString("utf8");
    }
  })()).rejects.toThrow();
  expect(visible).toBe(ordinary);
});

it.each([
  ["missing", {}],
  ["application/json", { "content-type": "application/json" }],
] as const)("withholds terminal SSE when the stream response MIME is %s", async (_mime, headers) => {
  const ordinary = ":ordinary\n\n";
  const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
  const request = await fixture((socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200, headers })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    socket.end(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 1, body: terminal })}\n`);
  });
  const response = await request();
  const reader = response.body!.getReader();
  let visible = "";
  await expect((async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      visible += Buffer.from(next.value).toString("utf8");
    }
  })()).rejects.toThrow();
  expect(visible).toBe(ordinary);
});

it("withholds terminal SSE in a legacy whole-body fallback despite a non-SSE MIME", async () => {
  const ordinary = ":ordinary\n\n";
  const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
  let releaseTail: () => void = () => undefined;
  const tail = new Promise<void>(resolve => { releaseTail = resolve; });
  const request = await fixture(async (socket, frame) => {
    socket.write(`${JSON.stringify({ version: 1, requestId: frame.requestId, ok: true, status: 200,
      headers: { "content-type": "application/json" }, body: ordinary + terminal })}\n`);
    await tail;
    socket.end("invalid trailing bytes");
  });
  try {
    const response = await request();
    const reader = response.body!.getReader();
    const first = Buffer.from((await reader.read()).value ?? []).toString("utf8");
    releaseTail();
    await expect(reader.read()).rejects.toThrow();
    expect(first).toBe(ordinary);
  } finally {
    releaseTail();
  }
});

it("releases a plain legacy whole-body reply only after its broker EOF", async () => {
  const request = await fixture((socket, frame) => {
    socket.end(`${JSON.stringify({ version: 1, requestId: frame.requestId, ok: true, status: 200,
      headers: { "content-type": "application/json" }, body: '{"answer":"hello"}' })}\n`);
  });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"answer":"hello"}');
});

it("releases a split terminal SSE event only after the valid end and Unix EOF", async () => {
  const ordinary = ":ordinary\n\n";
  const terminal = 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n';
  const done = "data: [DONE]\n\n";
  let releaseTerminal: () => void = () => undefined;
  const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
  let releaseEof: () => void = () => undefined;
  const eofGate = new Promise<void>(resolve => { releaseEof = resolve; });
  let signalEnd: () => void = () => undefined;
  const endSent = new Promise<void>(resolve => { signalEnd = resolve; });
  const request = await fixture(async (socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    await terminalGate;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 1, body: terminal.slice(0, 23) })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 2, body: terminal.slice(23) + done })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "end", sequence: 3 })}\n`);
    signalEnd();
    await eofGate;
    socket.end();
  });
  try {
    const response = await request();
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value ?? []).toString("utf8")).toBe(ordinary);
    releaseTerminal();
    await endSent;
    const next = reader.read();
    let settled = false;
    void next.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    releaseEof();
    let visible = Buffer.from((await next).value ?? []).toString("utf8");
    for (;;) {
      const rest = await reader.read();
      if (rest.done) break;
      visible += Buffer.from(rest.value).toString("utf8");
    }
    expect(visible).toBe(terminal + done);
  } finally {
    releaseTerminal();
    releaseEof();
  }
});

it("bounds one incomplete SSE event without imposing a total response cap", async () => {
  const ordinary = ":ordinary\n\n";
  const request = await fixture((socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    const oversized = ":" + "x".repeat(1024 * 1024);
    for (let offset = 0, sequence = 1; offset < oversized.length; offset += 64 * 1024, sequence++) {
      socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence,
        body: oversized.slice(offset, offset + 64 * 1024) })}\n`);
    }
    socket.end();
  });
  const response = await request();
  const reader = response.body!.getReader();
  let visible = "";
  await expect((async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      visible += Buffer.from(next.value).toString("utf8");
    }
  })()).rejects.toThrow();
  expect(visible).toBe(ordinary);
});

it("withholds terminal SSE even when a later bad sequence follows", async () => {
  const ordinary = ":ordinary\n\n";
  const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  let releaseTail: () => void = () => undefined;
  const tail = new Promise<void>(resolve => { releaseTail = resolve; });
  const request = await fixture(async (socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    await tail;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 1, body: terminal })}\n`);
    socket.end(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 3, body: "late" })}\n`);
  });
  try {
    const response = await request();
    const reader = response.body!.getReader();
    let visible = "";
    const first = await reader.read();
    visible += Buffer.from(first.value ?? []).toString("utf8");
    releaseTail();
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        visible += Buffer.from(next.value).toString("utf8");
      }
    })()).rejects.toThrow();
    expect(visible).toBe(ordinary);
  } finally {
    releaseTail();
  }
});

it("rejects a later SSE error after a terminal event", async () => {
  const ordinary = ":ordinary\n\n";
  const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const error = 'event: error\ndata: {"type":"error"}\n\n';
  let releaseTail: () => void = () => undefined;
  const tail = new Promise<void>(resolve => { releaseTail = resolve; });
  const request = await fixture(async (socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    await tail;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 1, body: terminal })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 2, body: error })}\n`);
    socket.end(`${JSON.stringify({ version: 1, requestId, stream: "end", sequence: 3 })}\n`);
  });
  try {
    const response = await request();
    const reader = response.body!.getReader();
    let visible = "";
    const first = await reader.read();
    visible += Buffer.from(first.value ?? []).toString("utf8");
    releaseTail();
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        visible += Buffer.from(next.value).toString("utf8");
      }
    })()).rejects.toThrow();
    expect(visible).toBe(ordinary);
  } finally {
    releaseTail();
  }
});

it("rejects an incomplete SSE tail after completion despite valid broker end and EOF", async () => {
  const ordinary = ":ordinary\n\n";
  const completed = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const done = "data: [DONE]\n\n";
  let releaseTail: () => void = () => undefined;
  const tail = new Promise<void>(resolve => { releaseTail = resolve; });
  const request = await fixture(async (socket, frame) => {
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ordinary })}\n`);
    await tail;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 1, body: completed + done + "garbage" })}\n`);
    socket.end(`${JSON.stringify({ version: 1, requestId, stream: "end", sequence: 2 })}\n`);
  });
  try {
    const response = await request();
    const reader = response.body!.getReader();
    let visible = Buffer.from((await reader.read()).value ?? []).toString("utf8");
    releaseTail();
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        visible += Buffer.from(next.value).toString("utf8");
      }
    })()).rejects.toThrow();
    expect(visible).toBe(ordinary);
  } finally {
    releaseTail();
  }
});

it("closes the broker socket when the Bot HTTP reader cancels a streamed body", async () => {
  let brokerClosed = false;
  const request = await fixture((socket, frame) => {
    socket.once("close", () => { brokerClosed = true; });
    const requestId = frame.requestId;
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
    socket.write(`${JSON.stringify({ version: 1, requestId, stream: "chunk", sequence: 0, body: ":partial\n\n" })}\n`);
  });
  const response = await request();
  expect(response.status).toBe(200);
  await response.body!.cancel();
  await vi.waitFor(() => expect(brokerClosed).toBe(true));
});

it("times out an inactive broker stream that never sends its end frame", async () => {
  let brokerClosed = false;
  const request = await fixture((socket, frame) => {
    socket.once("close", () => { brokerClosed = true; });
    socket.write(`${JSON.stringify({ version: 1, requestId: frame.requestId, stream: "start", status: 200,
      headers: { "content-type": "text/event-stream" } })}\n`);
  }, 50);
  await expect(request().then(response => response.text())).rejects.toThrow();
  await vi.waitFor(() => expect(brokerClosed).toBe(true));
});
