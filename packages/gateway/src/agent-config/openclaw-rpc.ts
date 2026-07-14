import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod/v4";
import { AgentConfigError } from "./errors.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const CONFIG_PATCH_LIMIT = 3;
const CONFIG_PATCH_WINDOW_MS = 60_000;
const ALLOWED_METHODS = new Set([
  "health",
  "channels.status",
  "models.list",
  "models.authStatus",
  "config.get",
  "config.patch",
]);

const ChallengeSchema = z.object({
  type: z.literal("event"),
  event: z.literal("connect.challenge"),
  payload: z.object({ nonce: z.string().min(1).max(512), ts: z.number() }).strict(),
}).strict();

const EventSchema = z.object({
  type: z.literal("event"),
  event: z.string().min(1).max(128),
  payload: z.unknown().optional(),
  seq: z.number().int().nonnegative().optional(),
  stateVersion: z.record(
    z.string().min(1).max(128),
    z.number().int().nonnegative(),
  ).refine((value) => Object.keys(value).length <= 64).optional(),
}).strict();

const ResponseSchema = z.object({
  type: z.literal("res"),
  id: z.string().uuid(),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z.unknown().optional(),
}).strict();

const RetryableConnectErrorSchema = z.object({
  code: z.literal("UNAVAILABLE"),
  details: z.object({
    reason: z.literal("startup-sidecars"),
    retryAfterMs: z.number().int().nonnegative().max(10_000).optional(),
  }).passthrough(),
  retryAfterMs: z.number().int().nonnegative().max(10_000).optional(),
}).passthrough();

const EmptyParamsSchema = z.object({}).strict();
const ConfigPatchParamsSchema = z.object({
  raw: z.string().min(2).max(MAX_REQUEST_BYTES),
  baseHash: z.string().min(1).max(256),
}).strict();
const MethodParamsSchemas: Record<string, z.ZodType> = {
  health: EmptyParamsSchema,
  "channels.status": EmptyParamsSchema,
  "models.list": EmptyParamsSchema,
  "models.authStatus": EmptyParamsSchema,
  "config.get": EmptyParamsSchema,
  "config.patch": ConfigPatchParamsSchema,
};

const HelloSchema = z.object({
  type: z.literal("hello-ok"),
  protocol: z.literal(4),
  server: z.object({
    version: z.string().min(1).max(128),
    connId: z.string().min(1).max(256),
  }).passthrough(),
  features: z.object({
    methods: z.array(z.string().min(1).max(128)).max(512),
    events: z.array(z.string().min(1).max(128)).max(512),
  }).passthrough(),
  snapshot: z.record(z.string(), z.unknown()),
  auth: z.object({
    role: z.literal("operator"),
    scopes: z.array(z.string().min(1).max(128)).max(32),
  }).passthrough(),
  policy: z.object({
    maxPayload: z.number().int().positive(),
    maxBufferedBytes: z.number().int().positive(),
    tickIntervalMs: z.number().int().positive(),
  }).passthrough(),
}).passthrough();

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

export interface OpenClawRpcClient {
  call(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface OpenClawRpcClientOptions {
  url: string;
  token: string;
  socketFactory?: (url: string) => SocketLike;
  maxPending?: number;
  timeoutMs?: number;
  now?: () => number;
}

function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AgentConfigError("agent_config_invalid", error);
  }
  if (url.protocol !== "ws:"
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "18789"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== "") {
    throw new AgentConfigError("agent_config_invalid");
  }
  return url.href;
}

function frameText(data: unknown): string {
  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : typeof data === "string"
          ? Buffer.from(data)
          : null;
  if (buffer === null || buffer.byteLength > MAX_FRAME_BYTES) {
    throw new AgentConfigError("invalid_response");
  }
  return buffer.toString("utf8");
}

function serializeRequest(id: string, method: string, params: unknown): string {
  const schema = MethodParamsSchemas[method];
  const parsed = schema?.safeParse(params);
  if (parsed?.success !== true) {
    throw new AgentConfigError("agent_config_invalid", parsed?.error);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify({ type: "req", id, method, params: parsed.data });
  } catch (error) {
    throw new AgentConfigError("agent_config_invalid", error);
  }
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) {
    throw new AgentConfigError("agent_config_invalid");
  }
  return serialized;
}

export function createOpenClawRpcClient(
  options: OpenClawRpcClientOptions,
): OpenClawRpcClient {
  const url = validateUrl(options.url);
  if (!/^[A-Fa-f0-9]{64}$/.test(options.token)) {
    throw new AgentConfigError("agent_config_invalid");
  }
  const maxPending = options.maxPending ?? 8;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 8) {
    throw new RangeError("Invalid OpenClaw pending-call cap");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new RangeError("Invalid OpenClaw RPC timeout");
  }
  const socketFactory = options.socketFactory ?? ((target: string) => new WebSocket(target, {
    handshakeTimeout: timeoutMs,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  }));

  const pending = new Map<string, PendingCall>();
  let socket: SocketLike | null = null;
  let closed = false;
  let connectId: string | null = null;
  let connectPromise: Promise<void> | null = null;
  let connectResolve: (() => void) | null = null;
  let connectReject: ((error: unknown) => void) | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let connectDeadline = 0;
  let reconnectAfter = 0;
  let configPatchInFlight = false;
  const configPatchWrites: number[] = [];

  function rejectPending(error: AgentConfigError): void {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(error);
    }
  }

  function failConnection(error: AgentConfigError): void {
    reconnectAfter = Math.max(reconnectAfter, now() + timeoutMs);
    if (connectTimer !== null) clearTimeout(connectTimer);
    if (connectRetryTimer !== null) clearTimeout(connectRetryTimer);
    connectTimer = null;
    connectRetryTimer = null;
    connectDeadline = 0;
    connectReject?.(error);
    connectResolve = null;
    connectReject = null;
    rejectPending(error);
    const failedSocket = socket;
    socket = null;
    connectPromise = null;
    connectId = null;
    if (failedSocket?.readyState !== WebSocket.CLOSED) failedSocket?.close();
  }

  function retryDelay(error: unknown): number | null {
    const parsed = RetryableConnectErrorSchema.safeParse(error);
    if (!parsed.success) return null;
    return parsed.data.retryAfterMs ?? parsed.data.details.retryAfterMs ?? null;
  }

  function scheduleConnectRetry(delayMs: number): void {
    if (connectPromise === null || now() + delayMs >= connectDeadline) {
      failConnection(new AgentConfigError("runtime_unavailable"));
      return;
    }
    const retrySocket = socket;
    socket = null;
    connectId = null;
    if (retrySocket?.readyState !== WebSocket.CLOSED) retrySocket?.close();
    connectRetryTimer = setTimeout(() => {
      connectRetryTimer = null;
      if (closed || connectPromise === null || now() >= connectDeadline) {
        failConnection(new AgentConfigError("runtime_unavailable"));
        return;
      }
      openSocket();
    }, delayMs);
  }

  function handleResponse(frame: z.infer<typeof ResponseSchema>): void {
    if (frame.id === connectId) {
      if (!frame.ok) {
        const delayMs = retryDelay(frame.error);
        if (delayMs !== null) {
          scheduleConnectRetry(delayMs);
          return;
        }
        failConnection(new AgentConfigError("runtime_unavailable"));
        return;
      }
      const hello = HelloSchema.safeParse(frame.payload);
      if (!hello.success
        || !hello.data.auth.scopes.includes("operator.read")
        || !hello.data.auth.scopes.includes("operator.write")
        || !hello.data.auth.scopes.includes("operator.admin")) {
        failConnection(new AgentConfigError("invalid_response", hello.error));
        return;
      }
      if (connectTimer !== null) clearTimeout(connectTimer);
      connectTimer = null;
      if (connectRetryTimer !== null) clearTimeout(connectRetryTimer);
      connectRetryTimer = null;
      connectDeadline = 0;
      connectId = null;
      reconnectAfter = 0;
      connectResolve?.();
      connectResolve = null;
      connectReject = null;
      return;
    }

    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(new AgentConfigError("invalid_response"));
  }

  function handleMessage(data: unknown): void {
    try {
      const raw = JSON.parse(frameText(data));
      const challenge = ChallengeSchema.safeParse(raw);
      if (challenge.success && connectResolve !== null && connectId === null) {
        connectId = randomUUID();
        socket?.send(JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: "gateway-client",
              version: "matrix-os",
              platform: "linux",
              mode: "backend",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.admin"],
            caps: [],
            commands: [],
            permissions: {},
            auth: { token: options.token },
            locale: "en-US",
            userAgent: "matrix-os-gateway",
          },
        }));
        return;
      }
      const response = ResponseSchema.safeParse(raw);
      if (response.success) {
        handleResponse(response.data);
        return;
      }
      if (EventSchema.safeParse(raw).success) return;
      throw new AgentConfigError("invalid_response", response.error);
    } catch (error) {
      console.warn(
        "[agent-config] OpenClaw RPC protocol failure:",
        error instanceof Error ? error.name : "UnknownError",
      );
      failConnection(error instanceof AgentConfigError
        ? error
        : new AgentConfigError("invalid_response", error));
    }
  }

  function openSocket(): void {
    try {
      const created = socketFactory(url);
      socket = created;
      created.on("message", (data) => {
        if (socket !== created) return;
        handleMessage(data);
      });
      created.on("close", () => {
        if (socket !== created) return;
        failConnection(new AgentConfigError("runtime_unavailable"));
      });
      created.on("error", () => {
        if (socket !== created) return;
        failConnection(new AgentConfigError("runtime_unavailable"));
      });
    } catch (error) {
      failConnection(new AgentConfigError("runtime_unavailable", error));
    }
  }

  function ensureConnected(): Promise<void> {
    if (closed) return Promise.reject(new AgentConfigError("runtime_unavailable"));
    if (connectPromise !== null) return connectPromise;
    if (now() < reconnectAfter) {
      return Promise.reject(new AgentConfigError("runtime_unavailable"));
    }
    const deferred = Promise.withResolvers<void>();
    const connecting = deferred.promise;
    connectPromise = connecting;
    connectResolve = deferred.resolve;
    connectReject = deferred.reject;
    connectDeadline = now() + timeoutMs;
    connectTimer = setTimeout(() => {
      failConnection(new AgentConfigError("runtime_unavailable"));
    }, timeoutMs);
    openSocket();
    return connecting;
  }

  async function waitForConnection(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AgentConfigError("runtime_unavailable");
    const connecting = ensureConnected();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new AgentConfigError("runtime_unavailable"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      connecting.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
      // Close the check-then-listen race when the caller aborts between the
      // initial guard and listener registration.
      if (signal.aborted) onAbort();
    });
  }

  function pruneConfigPatchWrites(): void {
    const cutoff = now() - CONFIG_PATCH_WINDOW_MS;
    while (configPatchWrites[0] !== undefined && configPatchWrites[0] <= cutoff) {
      configPatchWrites.shift();
    }
  }

  async function performCall(
    method: string,
    serialized: string,
    id: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    await waitForConnection(signal);
    if (closed || socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new AgentConfigError("runtime_unavailable");
    }
    if (pending.size >= maxPending) {
      throw new AgentConfigError("agent_config_conflict");
    }
    if (signal.aborted) throw new AgentConfigError("runtime_unavailable");
    const deferred = Promise.withResolvers<unknown>();
    const onAbort = () => {
      if (!pending.has(id)) return;
      failConnection(new AgentConfigError("runtime_unavailable"));
    };
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      failConnection(new AgentConfigError("runtime_unavailable"));
    }, timeoutMs);
    pending.set(id, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
      signal,
      onAbort,
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (method === "config.patch") configPatchWrites.push(now());
    try {
      socket.send(serialized);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const failure = new AgentConfigError("runtime_unavailable", error);
      failConnection(failure);
      throw failure;
    }
    return deferred.promise;
  }

  return {
    async call(method, params, signal) {
      if (!ALLOWED_METHODS.has(method)) {
        throw new AgentConfigError("agent_config_invalid");
      }
      const id = randomUUID();
      const serialized = serializeRequest(id, method, params);
      if (method !== "config.patch") {
        return performCall(method, serialized, id, signal);
      }
      pruneConfigPatchWrites();
      if (configPatchInFlight || configPatchWrites.length >= CONFIG_PATCH_LIMIT) {
        throw new AgentConfigError("agent_config_conflict");
      }
      configPatchInFlight = true;
      try {
        return await performCall(method, serialized, id, signal);
      } finally {
        configPatchInFlight = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectPending(new AgentConfigError("runtime_unavailable"));
      connectReject?.(new AgentConfigError("runtime_unavailable"));
      connectResolve = null;
      connectReject = null;
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (connectRetryTimer !== null) clearTimeout(connectRetryTimer);
      connectTimer = null;
      connectRetryTimer = null;
      connectDeadline = 0;
      socket?.close();
      socket = null;
      connectPromise = null;
      connectId = null;
      configPatchWrites.length = 0;
    },
  };
}
