/**
 * Loopback inference bridge shared by scope-runtime workloads. Model SDKs
 * inside the sandbox call this HTTP server on 127.0.0.1; each request becomes
 * one `inference.*` frame on the broker socket, where the gateway injects the
 * credential. The workload never holds a provider key or reaches the network.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { connect } from "node:net";

export const MAX_BRIDGE_REQUEST_BYTES = 256 * 1024;
export const MAX_BRIDGE_RESPONSE_BYTES = 512 * 1024;
const BROKER_TIMEOUT_MS = 30_000;
/** Upper bound for a caller-chosen broker wait (a funded background request may queue for minutes). */
const MAX_BROKER_TIMEOUT_MS = 11 * 60_000;

export type ScopeInferenceAction = "inference.messages" | "inference.responses" | "inference.chat_completions";

export class ScopeRuntimeBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeRuntimeBrokerError";
  }
}

/** Maps an SDK request path to its broker action; the bot adapter routes by API path. */
export function inferenceActionForPath(path: string | undefined): ScopeInferenceAction | undefined {
  const pathname = (path ?? "").split("?", 1)[0];
  if (pathname === "/v1/messages") return "inference.messages";
  if (pathname === "/v1/responses") return "inference.responses";
  if (pathname === "/v1/chat/completions") return "inference.chat_completions";
  return undefined;
}

/** One newline-delimited JSON request per connection, bounded in time and size. */
export function brokerRequest(
  socketPath: string,
  frame: Record<string, unknown>,
  maxResponseBytes = MAX_BRIDGE_RESPONSE_BYTES,
  timeoutMs = BROKER_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const timeout = Math.max(1, Math.min(Math.trunc(timeoutMs), MAX_BROKER_TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    socket.setTimeout(timeout, () => finish(new ScopeRuntimeBrokerError("Broker timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      response = Buffer.concat([response, bytes], response.length + bytes.length);
      if (response.length > maxResponseBytes) {
        finish(new ScopeRuntimeBrokerError("Broker response exceeded capacity"));
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(response.subarray(0, newline).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(new ScopeRuntimeBrokerError("Broker response is invalid"));
          return;
        }
        finish(undefined, parsed as Record<string, unknown>);
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) {
          console.warn("[scope-runtime] broker response parse failed:", error instanceof Error ? error.name : "UnknownError");
        }
        finish(new ScopeRuntimeBrokerError("Broker response is invalid"));
      }
    });
    socket.once("error", () => finish(new ScopeRuntimeBrokerError("Broker unavailable")));
    socket.once("end", () => finish(new ScopeRuntimeBrokerError("Broker closed without a response")));
  });
}

async function readHttpBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BRIDGE_REQUEST_BYTES) throw new ScopeRuntimeBrokerError("Provider request exceeded capacity");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export interface ScopeInferenceBridgeOptions {
  brokerSocket: string;
  runtimeHandle: string;
  executionGeneration: string;
  /** Returns the broker action for a request, or undefined to refuse it with 404. */
  actionFor(request: IncomingMessage): ScopeInferenceAction | undefined;
  /** How long one inference may wait on the broker; defaults to 30 seconds. */
  brokerTimeoutMs?: number;
}

export interface ScopeInferenceBridge {
  server: HttpServer;
  port: number;
  close(): Promise<void>;
}

export async function startInferenceBridge(options: ScopeInferenceBridgeOptions): Promise<ScopeInferenceBridge> {
  const server = createHttpServer(async (request, response) => {
    try {
      const action = options.actionFor(request);
      if (!action) {
        response.writeHead(404).end();
        return;
      }
      const body = await readHttpBody(request);
      const brokerResponse = await brokerRequest(options.brokerSocket, {
        version: 1,
        action,
        requestId: randomUUID(),
        runtimeHandle: options.runtimeHandle,
        executionGeneration: options.executionGeneration,
        method: request.method,
        path: request.url,
        headers: {
          ...(typeof request.headers["anthropic-version"] === "string"
            ? { "anthropic-version": request.headers["anthropic-version"] } : {}),
          ...(typeof request.headers["anthropic-beta"] === "string"
            ? { "anthropic-beta": request.headers["anthropic-beta"] } : {}),
        },
        body,
      }, MAX_BRIDGE_RESPONSE_BYTES, options.brokerTimeoutMs);
      if (brokerResponse.ok !== true || typeof brokerResponse.status !== "number"
        || typeof brokerResponse.body !== "string" || !brokerResponse.headers
        || typeof brokerResponse.headers !== "object") {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(brokerResponse.status, brokerResponse.headers as Record<string, string>);
      response.end(brokerResponse.body);
    } catch (error: unknown) {
      console.warn("[scope-runtime] inference bridge failed:",
        error instanceof Error ? error.name : "UnknownError");
      response.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new ScopeRuntimeBrokerError("Bridge unavailable");
  return {
    server,
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
