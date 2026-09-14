import {
  ScopeRuntimeBrokerRequestSchema,
  ScopeRuntimeBrokerResponseSchema,
  type ScopeRuntimeBrokerRequest,
  type ScopeRuntimeBrokerResponse,
} from "@matrix-os/scope-runtime/broker-protocol";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { Agent } from "undici";
import { z } from "zod/v4";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import {
  buildKernelCredentialLaunch,
  KernelCredentialAccessSourceIdSchema,
  type KernelCredentialAccessSourceId,
} from "../kernel-credentials.js";
import { validateCustomMcpUrl } from "../integrations/custom-mcp/security.js";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_IN_FLIGHT = 8;
const INFERENCE_TIMEOUT_MS = 30_000;
const EGRESS_TIMEOUT_MS = 10_000;
const MAX_REQUEST_FRAME_BYTES = 512 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024;
const MAX_BROKER_CONNECTIONS = 64;

const InferenceBodySchema = z.object({
  model: z.string().min(1).max(256),
  stream: z.literal(true),
  messages: z.array(z.unknown()).min(1).max(256),
  tools: z.array(z.unknown()).max(0).optional(),
}).passthrough();

const UniqueModelsSchema = z.array(z.string().min(1).max(256)).max(128)
  .refine((values) => new Set(values).size === values.length, "Duplicate allowed model");
const UniqueOriginsSchema = z.array(z.string().min(1).max(2_048).url()).max(16)
  .refine((values) => new Set(values).size === values.length, "Duplicate allowed origin");
const BrokerAuthorizationSchema = z.union([
  z.object({ allowed: z.literal(false) }).strict(),
  z.object({
    allowed: z.literal(true),
    accessSourceId: KernelCredentialAccessSourceIdSchema.optional(),
    allowedModelIds: UniqueModelsSchema,
    allowedEgressOrigins: UniqueOriginsSchema,
  }).strict(),
]);

export type ScopeRuntimeBrokerAuthorization =
  | { allowed: false }
  | {
      allowed: true;
      accessSourceId?: KernelCredentialAccessSourceId;
      allowedModelIds: readonly string[];
      allowedEgressOrigins: readonly string[];
    };

interface PinnedDispatcher {
  close(): Promise<void> | void;
}

type ResolveCredentials = typeof buildKernelCredentialLaunch;
type ResolveEgress = (url: string) => Promise<{ url: URL; dispatcher: PinnedDispatcher }>;

function failure(
  requestId: string,
  error: "action_denied" | "route_denied" | "invalid_request" | "request_too_large"
    | "capacity_exceeded" | "provider_unavailable" | "response_too_large",
): ScopeRuntimeBrokerResponse {
  return ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId, ok: false, error });
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new RangeError("response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch((error: unknown) => {
          console.warn("[collaboration] scope broker response cancellation failed:",
            error instanceof Error ? error.name : "UnknownError");
        });
        throw new RangeError("response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch((error: unknown) => {
    console.warn("[collaboration] scope broker response discard failed:",
      error instanceof Error ? error.name : "UnknownError");
  });
}

function safeResponseHeaders(response: Response, expected: "inference" | "egress") {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const allowed = expected === "inference"
    ? contentType === "text/event-stream"
    : contentType === "application/json" || contentType === "text/plain";
  if (!allowed) throw new Error("Unsafe scope broker content type");
  const headers: { "content-type"?: string; "cache-control"?: string } = {
    "content-type": contentType,
  };
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl && cacheControl.length <= 128 && /^[A-Za-z0-9 ,=_-]+$/.test(cacheControl)) {
    headers["cache-control"] = cacheControl;
  }
  return headers;
}

function exactAllowedOrigin(rawUrl: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length > 16) return false;
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      console.warn("[collaboration] scope broker URL parsing failed:",
        error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
  if (target.protocol !== "https:" || target.username || target.password || target.hash) return false;
  return allowedOrigins.some((origin) => {
    try {
      const allowed = new URL(origin);
      return allowed.protocol === "https:" && allowed.username === "" && allowed.password === ""
        && allowed.pathname === "/" && allowed.search === "" && allowed.hash === ""
        && allowed.origin === target.origin;
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) {
        console.warn("[collaboration] scope broker origin parsing failed:",
          error instanceof Error ? error.name : "UnknownError");
      }
      return false;
    }
  });
}

async function defaultResolveEgress(url: string): Promise<{ url: URL; dispatcher: Agent }> {
  const resolved = await validateCustomMcpUrl(url);
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, resolved.address, resolved.family);
      },
    },
  });
  return { url: resolved.url, dispatcher };
}

export function createScopeRuntimeBroker(options: {
  homePath: string;
  authorize(input: {
    runtimeHandle: string;
    executionGeneration: string;
    requestId: string;
    action: ScopeRuntimeBrokerRequest["action"];
    modelId?: string;
    url?: string;
  }): Promise<ScopeRuntimeBrokerAuthorization>;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  resolveCredentials?: ResolveCredentials;
  resolveEgress?: ResolveEgress;
  fetchImpl?: typeof fetch;
  maxInFlight?: number;
}) {
  const resolveCredentials = options.resolveCredentials ?? buildKernelCredentialLaunch;
  const resolveEgress = options.resolveEgress ?? defaultResolveEgress;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxInFlight = Math.max(1, Math.min(Math.trunc(options.maxInFlight ?? MAX_IN_FLIGHT), MAX_IN_FLIGHT));
  const lifetime = new AbortController();
  const operations = new Set<Promise<ScopeRuntimeBrokerResponse>>();
  let closed = false;

  async function execute(request: ScopeRuntimeBrokerRequest): Promise<ScopeRuntimeBrokerResponse> {
    let modelId: string | undefined;
    if (request.action === "inference.messages" && request.method === "POST") {
      try {
        modelId = InferenceBodySchema.parse(JSON.parse(request.body)).model;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
          console.warn("[collaboration] scope broker inference validation failed:",
            error instanceof Error ? error.name : "UnknownError");
        }
        return failure(request.requestId, "invalid_request");
      }
    }
    const authorization = BrokerAuthorizationSchema.parse(await options.authorize({
      runtimeHandle: request.runtimeHandle,
      executionGeneration: request.executionGeneration,
      requestId: request.requestId,
      action: request.action,
      ...(modelId ? { modelId } : {}),
      ...(request.action === "egress.fetch" ? { url: request.url } : {}),
    }));
    if (!authorization.allowed) return failure(request.requestId, "action_denied");

    if (request.action === "inference.messages") {
      if (request.method === "HEAD") {
        return ScopeRuntimeBrokerResponseSchema.parse({
          version: 1,
          requestId: request.requestId,
          ok: true,
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "",
        });
      }
      if (!modelId || !authorization.allowedModelIds.includes(modelId)
        || !authorization.accessSourceId) return failure(request.requestId, "action_denied");
      const credentialLaunch = await resolveCredentials(
        options.homePath,
        process.env,
        authorization.accessSourceId,
        options.fundedCredentialProvider,
      );
      const env = credentialLaunch.env;
      const apiKey = env?.ANTHROPIC_API_KEY;
      const authToken = env?.ANTHROPIC_AUTH_TOKEN;
      if ((!apiKey && !authToken) || (apiKey && authToken)) {
        return failure(request.requestId, "provider_unavailable");
      }
      const baseUrl = env?.ANTHROPIC_BASE_URL?.replace(/\/$/, "") ?? "https://api.anthropic.com";
      const headers = new Headers({
        accept: "text/event-stream",
        "content-type": "application/json",
      });
      if (apiKey) headers.set("x-api-key", apiKey);
      if (authToken) headers.set("authorization", `Bearer ${authToken}`);
      for (const [name, value] of Object.entries(request.headers)) {
        if (value) headers.set(name, value);
      }
      const response = await fetchImpl(`${baseUrl}${request.path}`, {
        method: "POST",
        headers,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(INFERENCE_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        await discard(response);
        return failure(request.requestId, "provider_unavailable");
      }
      const body = await readBoundedBody(response);
      return ScopeRuntimeBrokerResponseSchema.parse({
        version: 1,
        requestId: request.requestId,
        ok: true,
        status: response.status,
        headers: safeResponseHeaders(response, "inference"),
        body,
      });
    }

    if (!exactAllowedOrigin(request.url, authorization.allowedEgressOrigins)) {
      return failure(request.requestId, "action_denied");
    }
    const resolved = await resolveEgress(request.url);
    try {
      const response = await fetchImpl(resolved.url, {
        method: "GET",
        headers: { accept: request.accept },
        redirect: "error",
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(EGRESS_TIMEOUT_MS)]),
        dispatcher: resolved.dispatcher,
      } as RequestInit & { dispatcher: PinnedDispatcher });
      if (!response.ok) {
        await discard(response);
        return failure(request.requestId, "provider_unavailable");
      }
      const body = await readBoundedBody(response);
      return ScopeRuntimeBrokerResponseSchema.parse({
        version: 1,
        requestId: request.requestId,
        ok: true,
        status: response.status,
        headers: safeResponseHeaders(response, "egress"),
        body,
      });
    } finally {
      await resolved.dispatcher.close();
    }
  }

  return {
    handle(request: ScopeRuntimeBrokerRequest): Promise<ScopeRuntimeBrokerResponse> {
      if (closed) return Promise.resolve(failure(request.requestId, "provider_unavailable"));
      if (operations.size >= maxInFlight) {
        return Promise.resolve(failure(request.requestId, "capacity_exceeded"));
      }
      const operation = execute(request).catch((error: unknown) => {
        console.warn("[collaboration] scope broker action failed:",
          error instanceof Error ? error.name : "UnknownError");
        return error instanceof RangeError && error.message === "response_too_large"
          ? failure(request.requestId, "response_too_large")
          : failure(request.requestId, "provider_unavailable");
      });
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch((error: unknown) => {
        console.warn("[collaboration] scope broker cleanup failed:",
          error instanceof Error ? error.name : "UnknownError");
      });
      return operation;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      lifetime.abort();
      await Promise.allSettled([...operations]);
    },
  };
}

function notFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeBrokerSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error("Unsafe scope broker socket path");
    await unlink(path);
  } catch (error: unknown) {
    if (!notFound(error)) throw error;
  }
}

export function createScopeRuntimeBrokerServer(options: {
  socketPath: string;
  broker: {
    handle(request: ScopeRuntimeBrokerRequest): Promise<ScopeRuntimeBrokerResponse>;
    close(): Promise<void> | void;
  };
  maxConnections?: number;
  requestTimeoutMs?: number;
}) {
  const maxConnections = Math.max(1, Math.min(
    Math.trunc(options.maxConnections ?? MAX_BROKER_CONNECTIONS),
    MAX_BROKER_CONNECTIONS,
  ));
  const requestTimeoutMs = Math.max(1, Math.min(
    Math.trunc(options.requestTimeoutMs ?? 35_000),
    60_000,
  ));
  const sockets = new Set<Socket>();
  const operations = new Set<Promise<void>>();
  let server: Server | undefined;
  let closed = false;

  function accept(socket: Socket): void {
    if (closed || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let input = "";
    let rejected = false;
    socket.setEncoding("utf8");
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    socket.once("error", (error: unknown) => {
      console.warn("[collaboration] scope broker socket failed:",
        error instanceof Error ? error.name : "UnknownError");
    });
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (rejected) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_FRAME_BYTES) {
        rejected = true;
        input = "";
        socket.destroy();
      }
    });
    socket.once("end", () => {
      if (closed || rejected) {
        socket.destroy();
        return;
      }
      const operation = (async () => {
        try {
          const frames = input.split("\n").filter((frame) => frame.trim().length > 0);
          if (frames.length !== 1) {
            socket.destroy();
            return;
          }
          const request = ScopeRuntimeBrokerRequestSchema.parse(JSON.parse(frames[0]!));
          const response = await options.broker.handle(request);
          const frame = `${JSON.stringify(ScopeRuntimeBrokerResponseSchema.parse(response))}\n`;
          if (Buffer.byteLength(frame, "utf8") > MAX_RESPONSE_FRAME_BYTES) {
            socket.destroy();
            return;
          }
          if (!closed && !socket.destroyed) socket.end(frame);
          else socket.destroy();
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
            console.warn("[collaboration] scope broker request failed:",
              error instanceof Error ? error.name : "UnknownError");
          }
          socket.destroy();
        }
      })();
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch((error: unknown) => {
        console.warn("[collaboration] scope broker request cleanup failed:",
          error instanceof Error ? error.name : "UnknownError");
      });
    });
  }

  return {
    async start(): Promise<void> {
      if (closed || server) throw new Error("Scope broker server cannot start");
      await removeBrokerSocket(options.socketPath);
      const candidate = createServer({ allowHalfOpen: true }, accept);
      server = candidate;
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once("error", reject);
          candidate.listen(options.socketPath, resolve);
        });
        // Workloads use systemd DynamicUser, so filesystem ownership cannot be
        // assigned ahead of launch. Authorization still requires an active,
        // unpredictable runtime handle and current execution generation.
        await chmod(options.socketPath, 0o666);
      } catch (error: unknown) {
        server = undefined;
        candidate.close();
        throw error;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const current = server;
      server = undefined;
      const serverClosed = current
        ? new Promise<void>((resolve) => current.close(() => resolve()))
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await serverClosed;
      await Promise.allSettled([...operations]);
      await options.broker.close();
      try {
        const entry = await lstat(options.socketPath);
        if (entry.isSocket() && !entry.isSymbolicLink()) await unlink(options.socketPath);
      } catch (error: unknown) {
        if (!notFound(error)) {
          console.warn("[collaboration] scope broker socket cleanup failed:",
            error instanceof Error ? error.name : "UnknownError");
        }
      }
    },
  };
}
