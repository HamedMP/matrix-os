#!/usr/bin/env node

import { chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";

const SOCKET_PATH = "/run/matrix-scope/broker.sock";
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
const SOCKET_TIMEOUT_MS = 5_000;
const MODEL = "claude-haiku-4-5-20251001";

function responseFrame(value) {
  return `${JSON.stringify(value)}\n`;
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function providerResponse() {
  const messageId = "msg_scope_runtime_proof";
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "scope-sdk-ok" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function parseRequest(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error: "invalid_request" };
  }
  if (request?.version !== 1 || request?.action !== "inference.messages") {
    return { ok: false, error: "action_denied" };
  }
  if (request.method === "HEAD" && request.path === "/api/hello") {
    return {
      ok: true,
      status: 200,
      headers: { "x-matrix-scope-broker": "fixture" },
      body: "",
    };
  }
  const { path } = request;
  if (request.method !== "POST" || path !== "/v1/messages?beta=true") {
    return { ok: false, error: "route_denied" };
  }
  if (typeof request.body !== "string" || Buffer.byteLength(request.body) > MAX_PROVIDER_BODY_BYTES) {
    return { ok: false, error: "request_too_large" };
  }
  try {
    const body = JSON.parse(request.body);
    if (!Array.isArray(body.messages) || typeof body.model !== "string") {
      return { ok: false, error: "invalid_request" };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error: "invalid_request" };
  }
  return {
    ok: true,
    status: 200,
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      "x-matrix-scope-broker": "fixture",
    },
    body: providerResponse(),
  };
}

if (process.env.MATRIX_SCOPE_PROBE_DISPOSABLE !== "1") {
  process.stderr.write("scope_runtime_broker_requires_disposable_host\n");
  process.exit(2);
}

const server = createServer((socket) => {
  let request = Buffer.alloc(0);
  let settled = false;

  const finish = (response) => {
    if (settled) return;
    settled = true;
    socket.end(responseFrame(response));
  };

  socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish({ ok: false, error: "request_timeout" }));
  socket.on("data", (chunk) => {
    if (settled) return;
    request = Buffer.concat([request, chunk], request.length + chunk.length);
    if (request.length > MAX_REQUEST_BYTES) {
      finish({ ok: false, error: "request_too_large" });
      return;
    }
    const newline = request.indexOf(0x0a);
    if (newline < 0) return;
    finish(parseRequest(request.subarray(0, newline).toString("utf8")));
  });
  socket.on("error", () => {
    settled = true;
  });
});

server.on("error", () => {
  process.stderr.write("scope_runtime_broker_failed\n");
  process.exitCode = 1;
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await rm(SOCKET_PATH, { force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

server.listen(SOCKET_PATH, async () => {
  await chmod(SOCKET_PATH, 0o666);
  process.stdout.write("scope_runtime_broker=ready\n");
});
