import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { HermesGatewayProcess, HermesGatewaySpawn } from "../../packages/gateway/src/chat/hermes-stdio-client";

interface Request { id: number; method: string; params: Record<string, unknown> }

export function hermesStartupProcesses(options: {
  timeouts?: number;
  confirmExit?: boolean;
  ignoreMethod?: string;
  startupFailure?: "error" | "protocol" | "exit";
} = {}) {
  const children: ReturnType<typeof makeChild>[] = [];
  function makeChild() {
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const requests: Request[] = [];
    let exited = false;
    const send = (value: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
    const exit = () => { if (!exited) { exited = true; emitter.emit("exit", 0, null); } };
    const event = (type: string, payload: unknown = {}, sessionId = "hermes_live") => send({
      jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload },
    });
    const close = () => { if (options.confirmExit !== false) queueMicrotask(exit); };
    const process = Object.assign(emitter, { stdout, stderr,
      kill: vi.fn(close),
      stdin: { end: vi.fn(close), write: vi.fn((line: string) => {
        const request = JSON.parse(line) as Request;
        requests.push(request);
        if (request.method === options.ignoreMethod) return true;
        queueMicrotask(() => {
          const result = request.method === "session.create" || request.method === "session.resume"
            ? { session_id: "hermes_live", stored_session_id: "hermes_durable" }
            : request.method === "session.cwd.set" ? { cwd: request.params.cwd }
            : request.method === "config.set" ? { key: "yolo", value: "1", scope: "session" }
            : { status: "streaming" };
          send({ jsonrpc: "2.0", id: request.id, result });
        });
        return true;
      }) },
    }) satisfies HermesGatewayProcess;
    return { process, requests, event, exit, get exited() { return exited; } };
  }
  const spawnFn = vi.fn<HermesGatewaySpawn>(() => {
    if (children.length >= 6) throw new Error("Unexpected extra Hermes startup attempt");
    const child = makeChild();
    children.push(child);
    queueMicrotask(() => {
      if (options.startupFailure === "error") child.process.emit("error", new Error("ENOENT"));
      else if (options.startupFailure === "protocol") child.process.stdout.emit("data", Buffer.from("invalid\n"));
      else if (options.startupFailure === "exit") child.exit();
      else if (children.length > (options.timeouts ?? 0)) child.event("gateway.ready");
    });
    return child.process;
  });
  return { children, spawnFn, requests: () => children.flatMap((child) => child.requests) };
}

export const hermesStartupInput = {
  owner: { type: "personal" as const, ownerId: "owner_hermes_start" },
  chatId: "chat_hermes_start", turnId: "cturn_hermes_start", runId: "run_hermes_start",
  prompt: "Inspect one module.", parts: [{ type: "text" as const, text: "Inspect one module." }],
  selection: { instanceId: "hermes_default", model: "openai-codex:gpt-5.6-luna" },
  interactionMode: "default", permissionMode: "full_access", executionRoot: "/safe/project",
};
