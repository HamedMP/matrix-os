import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isBuiltin } from "node:module";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScopeRuntimeBotCommandError,
  botInferenceAction,
  parseScopeRuntimeBotCommandFrame,
  parseScopeRuntimeBotWorkerArguments,
  startBotCommandServer,
} from "../../packages/scope-runtime/src/worker-bot.js";
import { startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { buildWorkerBundle } from "./worker-bundles.js";

const execFileAsync = promisify(execFile);
const RUNTIME = `runtime_${"a".repeat(32)}`;
const SCOPE = `scope_${"b".repeat(32)}`;
const ARGS = [RUNTIME, SCOPE, "bot_agent", "matrix-bot", "1.0.0", "7"];
const invocation = parseScopeRuntimeBotWorkerArguments(ARGS);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

function send(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(body));
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("close", () => resolve(output));
    socket.once("error", reject);
  });
}

const frame = (command: Record<string, unknown>, overrides: Record<string, unknown> = {}) => `${JSON.stringify({
  version: 1, type: "runtime.bot", runtimeHandle: RUNTIME, executionGeneration: "7", command, ...overrides,
})}\n`;

describe("bot workload worker", () => {
  it("accepts only the pinned bot adapter invocation", () => {
    expect(invocation).toEqual({
      runtimeHandle: RUNTIME, scopeHandle: SCOPE, workload: "bot_agent", adapterId: "matrix-bot",
      harnessVersion: "1.0.0", executionGeneration: "7",
    });
    for (const bad of [
      [RUNTIME, SCOPE, "chat_ai", "matrix-bot", "1.0.0", "7"],
      [RUNTIME, SCOPE, "bot_agent", "claude-code", "2.1.240", "7"],
      [RUNTIME, SCOPE, "bot_agent", "matrix-bot", "0.86.1", "7"],
      [RUNTIME, SCOPE, "bot_agent", "matrix-bot", "0.87.0", "7"],
      [RUNTIME, SCOPE, "bot_agent", "matrix-bot", "1.0.0", "07"],
      [...ARGS, "/bin/sh"],
    ]) {
      expect(() => parseScopeRuntimeBotWorkerArguments(bad)).toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));
    }
  });

  it("accepts relayed commands only for its own runtime and generation", () => {
    const command = { version: 1, kind: "bot.cancel", runId: "run_one" };
    expect(parseScopeRuntimeBotCommandFrame(JSON.parse(frame(command)), invocation)).toEqual(command);
    for (const raw of [
      JSON.parse(frame(command, { runtimeHandle: `runtime_${"c".repeat(32)}` })),
      JSON.parse(frame(command, { executionGeneration: "8" })),
      JSON.parse(frame(command, { extra: true })),
      JSON.parse(frame({ ...command, kind: "bot.pause" })),
      JSON.parse(frame({ version: 1, kind: "bot.run", runId: "run_one", prompt: "inline prompt" })),
      [],
    ]) {
      expect(() => parseScopeRuntimeBotCommandFrame(raw, invocation)).toThrow(ScopeRuntimeBotCommandError);
    }
  });

  it("serves a long run and its control commands on separate connections", async () => {
    const directory = await createUnixSocketTempDir();
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, "worker.sock");
    let finishRun!: (value: Record<string, unknown>) => void;
    const handler = {
      handle: vi.fn(async (command: { kind: string }) => {
        if (command.kind === "bot.run") return new Promise<Record<string, unknown>>((resolve) => { finishRun = resolve; });
        if (command.kind === "bot.steer") throw new ScopeRuntimeBotCommandError("busy");
        if (command.kind === "bot.cancel") throw new Error("internal detail");
        return {};
      }),
    };
    const server = await startBotCommandServer({ socketPath, invocation, handler });
    cleanup.push(() => server.close());

    const run = send(socketPath, frame({ version: 1, kind: "bot.run", runId: "run_one" }));
    await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledTimes(1));
    await expect(send(socketPath, frame({ version: 1, kind: "bot.steer", runId: "run_one", text: "shorter" })))
      .resolves.toBe(`${JSON.stringify({ version: 1, ok: false, error: "busy" })}\n`);
    await expect(send(socketPath, frame({ version: 1, kind: "bot.cancel", runId: "run_one" })))
      .resolves.toBe(`${JSON.stringify({ version: 1, ok: false, error: "unavailable" })}\n`);
    await expect(send(socketPath, "not json\n"))
      .resolves.toBe(`${JSON.stringify({ version: 1, ok: false, error: "invalid_command" })}\n`);
    finishRun({ runId: "run_one", status: "completed" });
    await expect(run).resolves.toBe(`${JSON.stringify({ version: 1, ok: true, reply: { runId: "run_one", status: "completed" } })}\n`);
  });

  it("lets the capability-free supervisor reach a DynamicUser command socket", async () => {
    const directory = await createUnixSocketTempDir();
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, "worker.sock");
    const handler = { handle: vi.fn(async () => ({ acknowledged: true })) };
    const server = await startBotCommandServer({ socketPath, invocation, handler });
    cleanup.push(() => server.close());

    // The sandbox's 0077 umask otherwise leaves this socket owner-only. The
    // supervisor has no CAP_DAC_OVERRIDE and does not share the dynamic UID.
    expect((await stat(socketPath)).mode & 0o777).toBe(0o666);
    await expect(send(socketPath, frame({ version: 1, kind: "bot.cancel", runId: "run_one" })))
      .resolves.toContain('"acknowledged":true');
    await expect(send(socketPath, JSON.stringify({ version: 1, type: "runtime.bot", runtimeHandle: RUNTIME,
      executionGeneration: "999", command: { version: 1, kind: "bot.cancel", runId: "run_one" } }) + "\n"))
      .resolves.toContain('"invalid_command"');
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it("caps concurrent command connections", async () => {
    const directory = await createUnixSocketTempDir();
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, "worker.sock");
    const handler = { handle: vi.fn(() => new Promise<Record<string, unknown>>(() => undefined)) };
    const server = await startBotCommandServer({ socketPath, invocation, handler, maxConnections: 1 });
    cleanup.push(() => server.close());
    void send(socketPath, frame({ version: 1, kind: "bot.run", runId: "run_one" })).catch(() => undefined);
    await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledTimes(1));
    // The extra connection is closed before any reply; the client sees an empty stream or a reset.
    const refused = await send(socketPath, frame({ version: 1, kind: "bot.cancel", runId: "run_one" }))
      .catch((error: NodeJS.ErrnoException) => error.code);
    expect(["", "EPIPE", "ECONNRESET"]).toContain(refused);
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it("routes bridge requests by API path and refuses everything else", async () => {
    expect(botInferenceAction({ method: "POST", url: "/v1/messages" })).toBe("inference.messages");
    expect(botInferenceAction({ method: "POST", url: "/v1/responses" })).toBe("inference.responses");
    expect(botInferenceAction({ method: "POST", url: "/v1/chat/completions?stream=true" })).toBe("inference.chat_completions");
    expect(botInferenceAction({ method: "GET", url: "/v1/messages" })).toBeUndefined();
    expect(botInferenceAction({ method: "POST", url: "/v1/files" })).toBeUndefined();

    const directory = await createUnixSocketTempDir();
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const brokerSocket = join(directory, "broker.sock");
    const frames: Record<string, unknown>[] = [];
    const broker: Server = createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString("utf8");
        if (!input.includes("\n")) return;
        frames.push(JSON.parse(input.trim()) as Record<string, unknown>);
        socket.end(`${JSON.stringify({ ok: true, status: 200, headers: { "content-type": "application/json" }, body: "{\"id\":\"cmpl\"}" })}\n`);
      });
    });
    await new Promise<void>((resolve) => broker.listen(brokerSocket, resolve));
    cleanup.push(() => new Promise<void>((resolve) => broker.close(() => resolve())));
    const bridge = await startInferenceBridge({ brokerSocket, runtimeHandle: RUNTIME, executionGeneration: "7", actionFor: botInferenceAction });
    cleanup.push(() => bridge.close());

    const post = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: bridge.port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.once("error", reject);
      req.end("{\"model\":\"glm\"}");
    });
    await expect(post("/v1/chat/completions")).resolves.toEqual({ status: 200, body: "{\"id\":\"cmpl\"}" });
    expect(frames[0]).toMatchObject({
      version: 1, action: "inference.chat_completions", runtimeHandle: RUNTIME, executionGeneration: "7",
      method: "POST", path: "/v1/chat/completions", body: "{\"model\":\"glm\"}",
    });
    await expect(post("/v1/files")).resolves.toMatchObject({ status: 404 });
    expect(frames).toHaveLength(1);
  });

  it("waits on the broker for the configured time before answering 502", async () => {
    const directory = await createUnixSocketTempDir();
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const brokerSocket = join(directory, "silent.sock");
    const held: Socket[] = [];
    const silent: Server = createServer((socket) => { held.push(socket); });
    await new Promise<void>((resolve) => silent.listen(brokerSocket, resolve));
    cleanup.push(() => new Promise<void>((resolve) => {
      for (const socket of held) socket.destroy();
      silent.close(() => resolve());
    }));
    const bridge = await startInferenceBridge({
      brokerSocket, runtimeHandle: RUNTIME, executionGeneration: "7", actionFor: botInferenceAction, brokerTimeoutMs: 100,
    });
    cleanup.push(() => bridge.close());
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: bridge.port, path: "/v1/messages?beta=true", method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end("{}");
    });
    expect(status).toBe(502);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("ships as one file of Node built-ins that never includes the Chat worker entry", async () => {
    const bundle = await buildWorkerBundle("packages/bot-runtime/src/worker-entry.ts", { requireShim: true });
    cleanup.push(bundle.cleanup);
    expect(bundle.imports.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
    expect(bundle.inputs).not.toContain("packages/scope-runtime/src/worker.ts");
    expect(bundle.inputs).toContain("packages/scope-runtime/src/worker-bot.ts");

    // Invalid invocation and a non-sandbox identity fail with the fixed worker exit codes.
    await expect(execFileAsync(process.execPath, [bundle.outfile], { timeout: 10_000 }))
      .rejects.toMatchObject({ code: 87 });
    await expect(execFileAsync(process.execPath, [bundle.outfile, ...ARGS], {
      env: { ...process.env, MATRIX_AUTH_TOKEN: "owner-secret" }, timeout: 10_000,
    })).rejects.toMatchObject({ code: 85 });
  }, 60_000);
});
