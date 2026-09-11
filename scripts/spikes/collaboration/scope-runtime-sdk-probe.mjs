#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const SDK_DIRECTORY = "/opt/matrix/scope-sdk/sdk";
const NATIVE_EXECUTABLE = "/opt/matrix/scope-sdk/native/claude";
const BROKER_SOCKET = "/run/matrix-scope/broker.sock";
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 512 * 1024;
const IO_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 30_000;
const MODEL = "claude-haiku-4-5-20251001";
const SDK_PASS = "sdk_query:passed";

function brokerRequest(frame) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: BROKER_SOCKET });
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(IO_TIMEOUT_MS, () => finish(new Error("broker_timeout")));
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk], response.length + chunk.length);
      if (response.length > MAX_BROKER_RESPONSE_BYTES) {
        finish(new Error("broker_response_too_large"));
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(response.subarray(0, newline).toString("utf8")));
      } catch (error) {
        finish(error instanceof SyntaxError ? new Error("broker_response_invalid") : error);
      }
    });
    socket.once("error", () => finish(new Error("broker_unavailable")));
  });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function startBridge() {
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const brokerResponse = await brokerRequest({
        version: 1,
        action: "inference.messages",
        method: request.method,
        path: request.url,
        body,
      });
      if (
        brokerResponse?.ok !== true ||
        !Number.isInteger(brokerResponse.status) ||
        typeof brokerResponse.body !== "string" ||
        typeof brokerResponse.headers !== "object" ||
        brokerResponse.headers === null
      ) {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(brokerResponse.status, brokerResponse.headers);
      response.end(brokerResponse.body);
    } catch (error) {
      const category = error instanceof Error
        ? error.name.replaceAll(/[^A-Za-z0-9]/g, "_").slice(0, 32)
        : "UnknownError";
      process.stderr.write(`scope_runtime_sdk_bridge_failed:${category}\n`);
      response.writeHead(502).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge_unavailable");
  return { server, port: address.port };
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

if (process.env.MATRIX_SCOPE_PROBE_DISPOSABLE !== "1") {
  process.stderr.write("scope_runtime_sdk_probe_requires_disposable_host\n");
  process.exit(2);
}

let bridge;
try {
  const manifest = JSON.parse(await readFile(`${SDK_DIRECTORY}/package.json`, "utf8"));
  if (
    typeof manifest.version !== "string" ||
    !/^0\.[0-9]+\.[0-9]+$/.test(manifest.version) ||
    typeof manifest.claudeCodeVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.claudeCodeVersion)
  ) {
    throw new Error("unsupported_sdk_manifest");
  }
  await access(NATIVE_EXECUTABLE, constants.X_OK);

  const denied = await brokerRequest({
    version: 1,
    action: "host.fetch",
    method: "GET",
    path: "/",
    body: "",
  });
  if (denied?.ok !== false || denied?.error !== "action_denied") {
    throw new Error("broker_action_boundary_failed");
  }

  bridge = await startBridge();
  const runtime = await import(pathToFileURL(`${SDK_DIRECTORY}/sdk.mjs`).href);
  if (typeof runtime.query !== "function") throw new Error("sdk_query_unavailable");

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), QUERY_TIMEOUT_MS);
  let result;
  try {
    for await (const message of runtime.query({
      prompt: "Reply exactly scope-sdk-ok.",
      options: {
        abortController,
        allowedTools: [],
        cwd: "/workspace",
        disallowedTools: ["*"],
        env: {
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "scope-proof-placeholder",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CONFIG_DIR: "/workspace/.claude",
          HOME: "/workspace",
          NO_COLOR: "1",
          PATH: "/opt/matrix/runtime/node/bin",
        },
        executable: "node",
        maxTurns: 1,
        model: MODEL,
        pathToClaudeCodeExecutable: NATIVE_EXECUTABLE,
        persistSession: false,
        settingSources: [],
        tools: [],
      },
    })) {
      if (message.type === "result") result = message;
    }
  } finally {
    clearTimeout(timeout);
  }
  if (result?.subtype !== "success" || result?.is_error || result?.result !== "scope-sdk-ok") {
    throw new Error("sdk_query_failed");
  }

  process.stdout.write(`${JSON.stringify({
    status: SDK_PASS,
    sdkVersion: manifest.version,
    nativeHarnessVersion: manifest.claudeCodeVersion,
    brokerActionBoundary: "passed",
    brokerTransport: "unix_socket",
  })}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
    ? error.message
    : "sdk_probe_failed";
  process.stderr.write(`scope_runtime_sdk_probe_failed:${code}\n`);
  process.exitCode = 1;
} finally {
  if (bridge) await closeServer(bridge.server);
}
