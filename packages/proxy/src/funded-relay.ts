import { createHmac } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { parseProxyApiKey } from "./auth.js";

const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GLOBAL_CONCURRENCY = 64;
const DEFAULT_GLOBAL_RATE_LIMIT = 180;
const DEFAULT_RUNTIME_CONCURRENCY = 2;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RUNTIME_REGISTRY_SIZE = 10_000;
const RATE_WINDOW_MS = 60_000;
const CLOUDFLARE_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ANTHROPIC_BETA = /^[a-zA-Z0-9,._=\-]{1,1024}$/;

const FundedRequestSchema = z.object({
  model: z.string().regex(MODEL_ID),
  max_tokens: z.number().int().positive().max(128_000).optional(),
  stream: z.boolean().optional(),
  messages: z.array(z.unknown()).min(1).max(1_024),
  tools: z.array(z.unknown()).max(256).optional(),
}).passthrough();

export interface FundedRelayConfig {
  gatewayBaseUrl: string;
  gatewayToken: string;
  sharedSecret: string;
  allowedModels: ReadonlySet<string>;
  timeoutMs: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  globalConcurrency: number;
  globalRateLimitPerMinute: number;
  runtimeConcurrency: number;
  rateLimitPerMinute: number;
  maxRuntimeEntries: number;
}

interface FundedRelayDependencies extends FundedRelayConfig {
  fetch?: typeof fetch;
  now?: () => number;
}

interface RuntimeAdmission {
  active: number;
  count: number;
  windowStartedAt: number;
  lastTouchedAt: number;
}

interface AdmissionLease {
  release(): void;
}

export interface FundedRelay {
  register(app: Hono): void;
  close(): void;
}

function readEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("MATRIX_FUNDED_AI_ENABLED must be 0, 1, false, or true");
}

function readRequired(env: NodeJS.ProcessEnv, name: string, maxLength = 4_096): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when Matrix-funded AI is enabled`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = readRequired(env, name);
  if (value.length < 16) throw new Error(`${name} must be at least 16 characters`);
  return value;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readGatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = readRequired(env, "CLOUDFLARE_AI_GATEWAY_URL", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("CLOUDFLARE_AI_GATEWAY_URL must be a valid URL");
    }
    throw error;
  }
  const path = url.pathname.replace(/\/$/, "");
  const pathSegments = path.split("/").filter(Boolean);
  const isExpectedPath = pathSegments.length === 4
    && pathSegments[0] === "v1"
    && /^[a-f0-9]{32}$/.test(pathSegments[1] ?? "")
    && /^[a-zA-Z0-9_-]{1,64}$/.test(pathSegments[2] ?? "")
    && pathSegments[3] === "anthropic";
  if (
    url.protocol !== "https:"
    || url.hostname !== CLOUDFLARE_GATEWAY_HOST
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !isExpectedPath
  ) {
    throw new Error("CLOUDFLARE_AI_GATEWAY_URL must be an official Anthropic gateway URL");
  }
  return `${url.origin}${path}`;
}

function readAllowedModels(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = readRequired(env, "MATRIX_FUNDED_AI_MODELS", 4_096);
  const models = [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (models.length === 0 || models.length > 32 || models.some((model) => !MODEL_ID.test(model))) {
    throw new Error("MATRIX_FUNDED_AI_MODELS must contain 1 to 32 valid model IDs");
  }
  return new Set(models);
}

export function resolveFundedRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): FundedRelayConfig | null {
  if (!readEnabled(env.MATRIX_FUNDED_AI_ENABLED)) return null;

  return {
    gatewayBaseUrl: readGatewayBaseUrl(env),
    gatewayToken: readSecret(env, "CLOUDFLARE_AI_GATEWAY_TOKEN"),
    sharedSecret: readSecret(env, "PROXY_SHARED_SECRET"),
    allowedModels: readAllowedModels(env),
    timeoutMs: readInteger(env, "MATRIX_FUNDED_AI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 10_000, 15 * 60_000),
    maxBodyBytes: readInteger(
      env,
      "MATRIX_FUNDED_AI_MAX_BODY_BYTES",
      DEFAULT_BODY_LIMIT_BYTES,
      256,
      8 * 1024 * 1024,
    ),
    maxResponseBytes: readInteger(
      env,
      "MATRIX_FUNDED_AI_MAX_RESPONSE_BYTES",
      DEFAULT_RESPONSE_LIMIT_BYTES,
      1_024,
      128 * 1024 * 1024,
    ),
    globalConcurrency: readInteger(
      env,
      "MATRIX_FUNDED_AI_GLOBAL_CONCURRENCY",
      DEFAULT_GLOBAL_CONCURRENCY,
      1,
      10_000,
    ),
    globalRateLimitPerMinute: readInteger(
      env,
      "MATRIX_FUNDED_AI_GLOBAL_RATE_LIMIT",
      DEFAULT_GLOBAL_RATE_LIMIT,
      1,
      10_000,
    ),
    runtimeConcurrency: readInteger(
      env,
      "MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY",
      DEFAULT_RUNTIME_CONCURRENCY,
      1,
      100,
    ),
    rateLimitPerMinute: readInteger(
      env,
      "MATRIX_FUNDED_AI_RATE_LIMIT",
      DEFAULT_RATE_LIMIT,
      1,
      10_000,
    ),
    maxRuntimeEntries: readInteger(
      env,
      "MATRIX_FUNDED_AI_MAX_RUNTIME_ENTRIES",
      DEFAULT_RUNTIME_REGISTRY_SIZE,
      1,
      100_000,
    ),
  };
}

class AdmissionController {
  private active = 0;
  private closed = false;
  private globalCount = 0;
  private globalWindowStartedAt = 0;
  private readonly runtimes = new Map<string, RuntimeAdmission>();

  constructor(
    private readonly config: Pick<
      FundedRelayConfig,
      | "globalConcurrency"
      | "globalRateLimitPerMinute"
      | "runtimeConcurrency"
      | "rateLimitPerMinute"
      | "maxRuntimeEntries"
    >,
    private readonly now: () => number,
  ) {}

  acquire(runtimeId: string): AdmissionLease | null {
    if (this.closed || this.active >= this.config.globalConcurrency) return null;
    const now = this.now();
    this.sweep(now);
    if (now - this.globalWindowStartedAt >= RATE_WINDOW_MS) {
      this.globalCount = 0;
      this.globalWindowStartedAt = now;
    }
    if (this.globalCount >= this.config.globalRateLimitPerMinute) return null;
    let state = this.runtimes.get(runtimeId);
    if (!state) {
      if (this.runtimes.size >= this.config.maxRuntimeEntries) return null;
      state = { active: 0, count: 0, windowStartedAt: now, lastTouchedAt: now };
      this.runtimes.set(runtimeId, state);
    }
    if (now - state.windowStartedAt >= RATE_WINDOW_MS) {
      state.count = 0;
      state.windowStartedAt = now;
    }
    state.lastTouchedAt = now;
    if (state.active >= this.config.runtimeConcurrency || state.count >= this.config.rateLimitPerMinute) {
      return null;
    }

    state.active += 1;
    state.count += 1;
    this.active += 1;
    this.globalCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state!.active = Math.max(0, state!.active - 1);
        state!.lastTouchedAt = this.now();
        this.active = Math.max(0, this.active - 1);
      },
    };
  }

  close(): void {
    this.closed = true;
    this.runtimes.clear();
  }

  private sweep(now: number): void {
    if (this.runtimes.size < this.config.maxRuntimeEntries) return;
    for (const [runtimeId, state] of this.runtimes) {
      if (state.active === 0 && now - state.lastTouchedAt >= RATE_WINDOW_MS) {
        this.runtimes.delete(runtimeId);
      }
    }
  }
}

function opaqueRuntimeId(handle: string, sharedSecret: string): string {
  return createHmac("sha256", sharedSecret)
    .update(`funded-runtime:${handle}`)
    .digest("base64url");
}

function errorResponse(
  c: Context,
  status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 502 | 504,
  type: string,
  message: string,
): Response {
  return c.json({ type: "error", error: { type, message } }, status);
}

function safeUpstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const upstreamContentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  headers.set(
    "content-type",
    upstreamContentType.startsWith("text/event-stream")
      ? "text/event-stream"
      : "application/json",
  );
  headers.set("cache-control", "no-store");
  return headers;
}

function boundedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  lease: AdmissionLease,
  abortUpstream: (reason?: unknown) => void,
  lifetimeSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  let settled = false;
  const onLifetimeAbort = (): void => settle();
  const settle = (): void => {
    if (settled) return;
    settled = true;
    lifetimeSignal.removeEventListener("abort", onLifetimeAbort);
    lease.release();
  };
  if (lifetimeSignal.aborted) {
    settle();
  } else {
    lifetimeSignal.addEventListener("abort", onLifetimeAbort, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle();
          reader.releaseLock();
          controller.close();
          return;
        }
        seen += result.value.byteLength;
        if (seen > maxBytes) {
          abortUpstream("response limit exceeded");
          await reader.cancel("response limit exceeded");
          settle();
          controller.error(new Error("AI response exceeded the configured limit"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      abortUpstream(reason);
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
}

export function createFundedRelay(dependencies: FundedRelayDependencies): FundedRelay {
  const fetchImpl = dependencies.fetch ?? fetch;
  const admission = new AdmissionController(dependencies, dependencies.now ?? Date.now);
  // Controllers are added only after admission, so this set is bounded by the
  // configured global concurrency limit and is drained during shutdown.
  const activeRequests = new Set<AbortController>();

  const handler = async (c: Context): Promise<Response> => {
    if (c.req.method !== "POST") {
      return errorResponse(c, 404, "not_found_error", "AI route not found");
    }
    const path = c.req.path;
    if (path !== "/v1/messages" && path !== "/v1/messages/count_tokens") {
      return errorResponse(c, 404, "not_found_error", "AI route not found");
    }
    if (new URL(c.req.url).search !== "") {
      return errorResponse(c, 404, "not_found_error", "AI route not found");
    }
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return errorResponse(c, 415, "invalid_request_error", "Content-Type must be application/json");
    }

    const providedKey = c.req.header("x-api-key") ?? "";
    const runtime = parseProxyApiKey(providedKey, dependencies.sharedSecret);
    if (!runtime) {
      return errorResponse(c, 401, "authentication_error", "Unauthorized");
    }

    let requestBody: string;
    let parsedBody: z.infer<typeof FundedRequestSchema>;
    try {
      requestBody = await c.req.text();
      parsedBody = FundedRequestSchema.parse(JSON.parse(requestBody));
    } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      return errorResponse(c, 400, "invalid_request_error", "Invalid AI request");
    }
    if (path === "/v1/messages" && parsedBody.max_tokens === undefined) {
      return errorResponse(c, 400, "invalid_request_error", "Invalid AI request");
    }
    if (!dependencies.allowedModels.has(parsedBody.model)) {
      return errorResponse(c, 403, "permission_error", "This model is not enabled");
    }

    const runtimeId = opaqueRuntimeId(runtime.handle, dependencies.sharedSecret);
    const lease = admission.acquire(runtimeId);
    if (!lease) {
      return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
    }
    const upstreamController = new AbortController();
    activeRequests.add(upstreamController);
    let released = false;
    const activeLease: AdmissionLease = {
      release: () => {
        if (released) return;
        released = true;
        activeRequests.delete(upstreamController);
        lease.release();
      },
    };

    const headers = new Headers({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "cf-aig-authorization": `Bearer ${dependencies.gatewayToken}`,
      "cf-aig-collect-log-payload": "false",
      "cf-aig-zdr": "true",
      "cf-aig-metadata": JSON.stringify({
        runtime_id: runtimeId,
        access_source: "matrix_included",
      }),
    });
    const anthropicBeta = c.req.header("anthropic-beta");
    if (anthropicBeta && ANTHROPIC_BETA.test(anthropicBeta)) {
      headers.set("anthropic-beta", anthropicBeta);
    }

    try {
      const signal = AbortSignal.any([
        c.req.raw.signal,
        upstreamController.signal,
        AbortSignal.timeout(dependencies.timeoutMs),
      ]);
      const upstream = await fetchImpl(`${dependencies.gatewayBaseUrl}${path}`, {
        method: "POST",
        headers,
        body: requestBody,
        redirect: "error",
        signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        activeLease.release();
        if (upstream.status === 429) {
          return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
        }
        console.warn("[proxy] Funded AI upstream rejected request", { status: upstream.status });
        return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
      }
      if (!upstream.body) {
        activeLease.release();
        return new Response(null, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
      }
      return new Response(boundedBody(
        upstream.body,
        dependencies.maxResponseBytes,
        activeLease,
        (reason) => upstreamController.abort(reason),
        signal,
      ), {
        status: upstream.status,
        headers: safeUpstreamHeaders(upstream),
      });
    } catch (error) {
      activeLease.release();
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI upstream request failed", { errorName });
      if (errorName === "TimeoutError") {
        return errorResponse(c, 504, "timeout_error", "AI access timed out");
      }
      return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
    }
  };

  return {
    register(app) {
      app.use("/v1/*", bodyLimit({
        maxSize: dependencies.maxBodyBytes,
        onError: (c) => errorResponse(
          c,
          413,
          "invalid_request_error",
          "AI request is too large",
        ),
      }));
      app.all("/v1/*", handler);
    },
    close() {
      for (const controller of activeRequests) {
        controller.abort("relay shutting down");
      }
      activeRequests.clear();
      admission.close();
    },
  };
}
