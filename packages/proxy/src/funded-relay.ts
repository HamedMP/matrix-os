import { createHmac, randomUUID } from "node:crypto";
import { FundedAiPolicyCheckRequestSchema, type FundedAiIdentity } from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { isFundedProxyApiKey } from "./auth.js";
import { AdmissionController, type AdmissionLease } from "./funded-relay-admission.js";
import { COUNT_TOKENS_BODY_LIMIT_BYTES, type FundedRelayConfig } from "./funded-relay-config.js";
import { estimateWorstCaseMicrousd, mapFundedModel } from "./funded-relay-model.js";
import {
  createFundedPlatformClient,
  FundedControlPlaneError,
  type FundedPlatformClient,
} from "./funded-relay-platform-client.js";
import {
  resolveRequestedBetas,
  serializeCountTokensRequest,
  serializeFundedRequest,
  type FundedRequest,
} from "./funded-relay-request.js";
import { boundedBody, safeUpstreamHeaders } from "./funded-relay-stream.js";

const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
const CountTokensResponseSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(10_000_000),
}).strict();

interface FundedRelayDependencies extends FundedRelayConfig {
  fetch?: typeof fetch;
  now?: () => Date;
  requestIdFactory?: () => string;
  platformClient?: FundedPlatformClient;
}

type VerifiedFundedIdentity = FundedAiIdentity & {
  tokenId: string;
  audience: string;
  scope: string;
  expiresAt: string;
};

interface ActiveRequestState {
  controller: AbortController;
  globalLease: AdmissionLease;
  lifetimeSignal: AbortSignal;
  resourceLease: AdmissionLease | null;
  handedOff: boolean;
}

export interface FundedRelay {
  register(app: Hono): void;
  close(): void;
}

function opaqueRef(secret: string, domain: string, value: string): string {
  return createHmac("sha256", secret).update(`${domain}:${value}`).digest("base64url");
}

function runtimeAdmissionRef(identity: FundedAiIdentity, secret: string): string {
  return opaqueRef(secret, "admission-runtime", `${identity.ownerId}:${identity.machineId}:${identity.runtimeSlot}`);
}

function cloudflareMetadata(input: {
  identity: FundedAiIdentity;
  canonicalModelId: string;
  requestId: string;
  secret: string;
}): Record<string, string> {
  return {
    access_source: "matrix_funded",
    matrix_user_ref: opaqueRef(input.secret, "owner", input.identity.ownerId),
    model_ref: opaqueRef(input.secret, "model", input.canonicalModelId),
    run_ref: opaqueRef(input.secret, "run", input.requestId),
    runtime_ref: opaqueRef(
      input.secret,
      "runtime",
      `${input.identity.machineId}:${input.identity.runtimeSlot}`,
    ),
  };
}

function errorResponse(
  c: Context,
  status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 502 | 503 | 504,
  type: string,
  message: string,
): Response {
  return c.json({ type: "error", error: { type, message } }, status);
}

function controlPlaneError(c: Context, error: unknown): Response {
  if (error instanceof FundedControlPlaneError) {
    if (error.status === 401) return errorResponse(c, 401, "authentication_error", "Unauthorized");
    if (error.status === 402 || error.status === 403) {
      return errorResponse(c, 403, "permission_error", "Matrix-funded AI is unavailable");
    }
    if (error.status === 429) {
      return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
    }
  }
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.warn("[proxy] Funded AI control request failed", { errorName });
  return errorResponse(c, 503, "api_error", "AI access is temporarily unavailable");
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel("response limit exceeded");
    throw new Error("AI response exceeded the configured limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel("response limit exceeded");
        throw new Error("AI response exceeded the configured limit");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function cloudflareHeaders(input: {
  anthropicBeta: string | null;
  gatewayToken: string;
  metadata: Record<string, string>;
}): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "cf-aig-authorization": `Bearer ${input.gatewayToken}`,
    "cf-aig-collect-log-payload": "false",
    "cf-aig-zdr": "true",
    "cf-aig-metadata": JSON.stringify(input.metadata),
  });
  if (input.anthropicBeta) headers.set("anthropic-beta", input.anthropicBeta);
  return headers;
}

function identitiesMatch(left: VerifiedFundedIdentity, right: VerifiedFundedIdentity): boolean {
  return left.tokenId === right.tokenId && left.ownerId === right.ownerId
    && left.machineId === right.machineId && left.runtimeSlot === right.runtimeSlot
    && left.audience === right.audience && left.scope === right.scope && left.expiresAt === right.expiresAt;
}

function createDisabledRelay(): FundedRelay {
  return {
    register(app) {
      app.all("/v1/*", async (c, next) => {
        if (!isFundedProxyApiKey(c.req.header("x-api-key") ?? "")) return next();
        return errorResponse(c, 403, "permission_error", "Matrix-funded AI is disabled");
      });
    },
    close() {
      // Disabled relays own no resources.
    },
  };
}

export function createFundedRelay(dependencies: FundedRelayDependencies | null): FundedRelay {
  if (!dependencies) return createDisabledRelay();
  const config = dependencies;
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const requestIdFactory = config.requestIdFactory ?? randomUUID;
  const admission = new AdmissionController(config, () => now().getTime());
  const platform = config.platformClient ?? createFundedPlatformClient({ ...config, fetch: fetchImpl });
  const activeRequests = new Set<AbortController>();
  const requestStates = new WeakMap<Context, ActiveRequestState>();

  async function releaseBeforeStart(
    reservationId: string,
    tokenId: string,
  ): Promise<void> {
    try {
      await platform.release(
        { reservationId, tokenId, reason: "pre_upstream_failure" },
        AbortSignal.timeout(config.platformTimeoutMs),
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI pre-start release failed", { errorName });
    }
  }

  async function countTokens(input: {
    requestBody: string;
    headers: Headers;
    signal: AbortSignal;
  }): Promise<{ response: Response; inputTokens: number }> {
    const response = await fetchImpl(`${config.gatewayBaseUrl}${COUNT_TOKENS_PATH}`, {
      method: "POST",
      headers: input.headers,
      body: input.requestBody,
      redirect: "error",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(config.countTokensTimeoutMs)]),
    });
    const text = await readBoundedText(response, config.maxControlResponseBytes);
    if (!response.ok) {
      if (response.status === 429) throw new FundedControlPlaneError(429);
      throw new Error("AI token counting failed");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("AI token count response was invalid");
      throw error;
    }
    const parsed = CountTokensResponseSchema.parse(value);
    return {
      response: new Response(JSON.stringify(parsed), { status: 200, headers: safeUpstreamHeaders(response) }),
      inputTokens: parsed.input_tokens,
    };
  }

  async function handle(c: Context, state: ActiveRequestState): Promise<Response> {
    let parsedBody: FundedRequest;
    let requestBody: string;
    let anthropicBeta: string | null;
    let model: ReturnType<typeof mapFundedModel>;
    try {
      const serialized = serializeFundedRequest(JSON.parse(await c.req.text()));
      parsedBody = serialized.request;
      requestBody = serialized.body;
      anthropicBeta = resolveRequestedBetas(c.req.header("anthropic-beta"), config.allowedBetas);
      model = mapFundedModel(parsedBody.model);
    } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      if (error instanceof Error && error.message === "Unsupported funded AI model") {
        return errorResponse(c, 403, "permission_error", "This model is not enabled");
      }
      return errorResponse(c, 400, "invalid_request_error", "Invalid AI request");
    }
    if (c.req.path === MESSAGES_PATH && parsedBody.max_tokens === undefined) {
      return errorResponse(c, 400, "invalid_request_error", "Invalid AI request");
    }

    const credential = c.req.header("x-api-key") ?? "";
    const checkInput = FundedAiPolicyCheckRequestSchema.safeParse({
      credential,
      modelId: model.canonicalModelId,
    });
    if (!checkInput.success) return errorResponse(c, 401, "authentication_error", "Unauthorized");
    let checked: Awaited<ReturnType<FundedPlatformClient["check"]>>;
    try {
      checked = await platform.check(checkInput.data, state.lifetimeSignal);
    } catch (error) {
      return controlPlaneError(c, error);
    }
    const runtimeRef = runtimeAdmissionRef(checked.identity, config.metadataSecret);
    if (!admission.admitRuntime(runtimeRef)) {
      return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
    }
    const requestId = requestIdFactory();
    const upstreamHeaders = cloudflareHeaders({
      anthropicBeta,
      gatewayToken: config.gatewayToken,
      metadata: cloudflareMetadata({
        identity: checked.identity,
        canonicalModelId: model.canonicalModelId,
        requestId,
        secret: config.metadataSecret,
      }),
    });

    let counted: Awaited<ReturnType<typeof countTokens>>;
    try {
      counted = await countTokens({
        requestBody: serializeCountTokensRequest(parsedBody),
        headers: upstreamHeaders,
        signal: state.lifetimeSignal,
      });
    } catch (error) {
      if (state.lifetimeSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
        return errorResponse(c, 504, "timeout_error", "AI access timed out");
      }
      if (error instanceof FundedControlPlaneError && error.status === 429) {
        return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
      }
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI token counting failed", { errorName });
      return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
    }
    if (c.req.path === COUNT_TOKENS_PATH) return counted.response;

    let maxCostMicrousd: number;
    try {
      maxCostMicrousd = estimateWorstCaseMicrousd({
        canonicalModelId: model.canonicalModelId,
        inputTokens: counted.inputTokens,
        maxOutputTokens: parsedBody.max_tokens!,
        now: now(),
      }).amountMicrousd;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI pricing unavailable", { errorName });
      return errorResponse(c, 503, "api_error", "AI access is temporarily unavailable");
    }

    let authorization: Awaited<ReturnType<FundedPlatformClient["authorize"]>>;
    try {
      authorization = await platform.authorize({
        credential,
        requestId,
        modelId: model.canonicalModelId,
        maxCostMicrousd,
      }, state.lifetimeSignal);
    } catch (error) {
      return controlPlaneError(c, error);
    }
    const reservation = authorization.reservation;
    if (!identitiesMatch(checked.identity, authorization.identity)
      || reservation.requestId !== requestId || reservation.modelId !== model.canonicalModelId
      || reservation.reservedMicrousd !== maxCostMicrousd) {
      await releaseBeforeStart(reservation.reservationId, authorization.identity.tokenId);
      return errorResponse(c, 503, "api_error", "AI access is temporarily unavailable");
    }
    const acquiredLease = admission.acquireResources(runtimeRef);
    if (!acquiredLease) {
      await releaseBeforeStart(reservation.reservationId, authorization.identity.tokenId);
      return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
    }
    let resourceReleased = false;
    const resourceLease: AdmissionLease = {
      release: () => {
        if (resourceReleased) return;
        resourceReleased = true;
        acquiredLease.release();
        state.globalLease.release();
        activeRequests.delete(state.controller);
      },
    };
    state.resourceLease = resourceLease;

    const firstResponseController = new AbortController();
    const firstResponseTimer = setTimeout(() => {
      firstResponseController.abort(new DOMException("AI first response timed out", "TimeoutError"));
    }, config.firstResponseTimeoutMs);
    const generationSignal = AbortSignal.any([state.lifetimeSignal, firstResponseController.signal]);
    const generationUrl = `${config.gatewayBaseUrl}${MESSAGES_PATH}`;
    const generationInit: RequestInit = {
      method: "POST",
      headers: upstreamHeaders,
      body: requestBody,
      redirect: "error",
      signal: generationSignal,
    };
    try {
      await platform.start(
        { reservationId: reservation.reservationId, tokenId: authorization.identity.tokenId },
        state.lifetimeSignal,
      );
      const upstream = await fetchImpl(generationUrl, generationInit);
      clearTimeout(firstResponseTimer);
      if (!upstream.ok) {
        await upstream.body?.cancel("upstream rejected request");
        resourceLease.release();
        state.resourceLease = null;
        if (upstream.status === 429) {
          return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
        }
        console.warn("[proxy] Funded AI upstream rejected request", { status: upstream.status });
        return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
      }
      if (!upstream.body) {
        resourceLease.release();
        state.resourceLease = null;
        return new Response(null, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
      }
      const responseBody = boundedBody(
        upstream.body,
        config.maxResponseBytes,
        resourceLease,
        (reason) => state.controller.abort(reason),
        state.lifetimeSignal,
      );
      state.handedOff = true;
      return new Response(responseBody, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
    } catch (error) {
      clearTimeout(firstResponseTimer);
      resourceLease.release();
      state.resourceLease = null;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI upstream request failed", { errorName });
      if (state.lifetimeSignal.aborted || firstResponseController.signal.aborted) {
        return errorResponse(c, 504, "timeout_error", "AI access timed out");
      }
      return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
    }
  }

  return {
    register(app) {
      app.use("/v1/*", async (c, next) => {
        const providedKey = c.req.header("x-api-key") ?? "";
        if (!isFundedProxyApiKey(providedKey)) return next();
        if (c.req.method !== "POST") return errorResponse(c, 404, "not_found_error", "AI route not found");
        if (c.req.path !== MESSAGES_PATH && c.req.path !== COUNT_TOKENS_PATH) {
          return errorResponse(c, 404, "not_found_error", "AI route not found");
        }
        if (new URL(c.req.url).search !== "") return errorResponse(c, 404, "not_found_error", "AI route not found");
        if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
          return errorResponse(c, 415, "invalid_request_error", "Content-Type must be application/json");
        }
        const globalLease = admission.acquireGlobal();
        if (!globalLease) {
          return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
        }
        const controller = new AbortController();
        activeRequests.add(controller);
        const state: ActiveRequestState = {
          controller,
          globalLease,
          lifetimeSignal: AbortSignal.any([
            c.req.raw.signal,
            controller.signal,
            AbortSignal.timeout(config.timeoutMs),
          ]),
          resourceLease: null,
          handedOff: false,
        };
        requestStates.set(c, state);
        try {
          await next();
        } finally {
          requestStates.delete(c);
          if (!state.handedOff) {
            state.resourceLease?.release();
            state.globalLease.release();
            activeRequests.delete(controller);
          }
        }
      });

      const limit = (maxSize: number) => bodyLimit({
        maxSize,
        onError: (c: Context) => errorResponse(c, 413, "invalid_request_error", "AI request is too large"),
      });
      const messagesLimit = limit(config.maxBodyBytes);
      const countLimit = limit(Math.min(config.maxBodyBytes, COUNT_TOKENS_BODY_LIMIT_BYTES));
      app.use(MESSAGES_PATH, async (c, next) => requestStates.has(c) ? messagesLimit(c, next) : next());
      app.use(COUNT_TOKENS_PATH, async (c, next) => requestStates.has(c) ? countLimit(c, next) : next());
      app.all("/v1/*", async (c, next) => {
        const state = requestStates.get(c);
        return state ? handle(c, state) : next();
      });
    },
    close() {
      for (const controller of activeRequests) controller.abort("relay shutting down");
      activeRequests.clear();
      admission.close();
    },
  };
}

export type { FundedRelayConfig } from "./funded-relay-config.js";
export { resolveFundedRelayConfig } from "./funded-relay-config.js";
