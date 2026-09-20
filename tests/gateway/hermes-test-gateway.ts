import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { HermesGatewayProcess, HermesGatewaySpawn } from "../../packages/gateway/src/chat/hermes-stdio-client.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeStream extends EventEmitter {}

export function fakeGateway(options: { emitReady?: boolean; ignoreMethods?: readonly string[] } = {}) {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const emitter = new EventEmitter();
  const requests: RpcRequest[] = [];
  const send = (frame: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  const respond = (request: RpcRequest, result: unknown) => send({ jsonrpc: "2.0", id: request.id, result });
  const stdin = {
    write: vi.fn((chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const request = JSON.parse(line) as RpcRequest;
        requests.push(request);
        if (options.ignoreMethods?.includes(request.method)) continue;
        queueMicrotask(() => {
          if (request.method === "session.create") {
            respond(request, { session_id: "live_session", stored_session_id: "durable_session" });
          } else if (request.method === "session.resume") {
            respond(request, { session_id: "live_session", session_key: request.params.session_id });
          } else if (request.method === "prompt.submit") {
            respond(request, { status: "streaming" });
          } else if (request.method === "session.interrupt") {
            respond(request, { status: "interrupted" });
          } else if (request.method === "session.steer") {
            respond(request, { status: "queued", text: request.params.text });
          } else if (request.method === "config.set" && request.params.key === "yolo") {
            respond(request, { key: "yolo", value: "1", scope: "session" });
          } else if (request.method === "config.set" && request.params.key === "model") {
            respond(request, { key: "model", value: request.params.value, confirm_required: false });
          } else if (request.method === "session.cwd.set") {
            respond(request, { cwd: request.params.cwd });
          } else if (request.method === "approval.respond") {
            respond(request, { resolved: true });
          } else {
            respond(request, {});
          }
        });
      }
      return true;
    }),
    end: vi.fn(() => queueMicrotask(() => emitter.emit("exit", 0, null))),
  };
  const kill = vi.fn((signal: NodeJS.Signals) => queueMicrotask(() => emitter.emit("exit", null, signal)));
  const process = Object.assign(emitter, { stdin, stdout, stderr, kill }) as unknown as HermesGatewayProcess;
  const spawnFn = vi.fn<HermesGatewaySpawn>(() => {
    if (options.emitReady !== false) {
      queueMicrotask(() => send({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: { change_events: true } },
      }));
    }
    return process;
  });
  return {
    process,
    requests,
    respond,
    spawnFn,
    sendRaw(value: string) {
      stdout.emit("data", Buffer.from(value));
    },
    event(type: string, payload: unknown, sessionId = "live_session") {
      send({
        jsonrpc: "2.0",
        method: "event",
        params: { type, session_id: sessionId, payload },
      });
    },
  };
}

export const baseInput = {
  owner: { type: "personal" as const, ownerId: "owner_hermes" },
  chatId: "chat_hermes",
  turnId: "cturn_hermes",
  runId: "run_hermes",
  prompt: "hello",
  parts: [{ type: "text" as const, text: "hello" }],
  selection: { instanceId: "hermes_default", model: "openai-codex:gpt-5.6-luna" },
  interactionMode: "default",
  permissionMode: "full_access",
  executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

