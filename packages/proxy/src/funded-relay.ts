import { createHmac } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  isFundedProxyApiKey,
  parseFundedProxyApiKey,
} from "./auth.js";
import {
  AdmissionController,
  type AdmissionLease,
} from "./funded-relay-admission.js";
import {
  COUNT_TOKENS_BODY_LIMIT_BYTES,
  type FundedRelayConfig,
} from "./funded-relay-config.js";
import {
  resolveRequestedBetas,
  serializeFundedRequest,
} from "./funded-relay-request.js";
import { boundedBody, safeUpstreamHeaders } from "./funded-relay-stream.js";

const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";

interface FundedRelayDependencies extends FundedRelayConfig {
  fetch?: typeof fetch;
  now?: () => number;
}

interface ActiveRequestState {
  activeLease: AdmissionLease;
  controller: AbortController;
  lifetimeSignal: AbortSignal;
  handedOff: boolean;
}

export interface FundedRelay {
  register(app: Hono): void;
  close(): void;
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

function isTimeoutSignal(signal: AbortSignal): boolean {
  return signal.aborted
    && signal.reason instanceof Error
    && signal.reason.name === "TimeoutError";
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
      // No resources are created while the funded relay is disabled.
    },
  };
}

export function createFundedRelay(dependencies: FundedRelayDependencies | null): FundedRelay {
  if (!dependencies) return createDisabledRelay();

  const fetchImpl = dependencies.fetch ?? fetch;
  const admission = new AdmissionController(dependencies, dependencies.now ?? Date.now);
  const activeRequests = new Set<AbortController>();
  const requestStates = new WeakMap<Context, ActiveRequestState>();

  const handler = async (c: Context, state: ActiveRequestState): Promise<Response> => {
    let requestBody: string;
    let parsedBody: ReturnType<typeof serializeFundedRequest>["request"];
    let anthropicBeta: string | null;
    try {
      const rawBody = await c.req.text();
      const serialized = serializeFundedRequest(JSON.parse(rawBody));
      requestBody = serialized.body;
      parsedBody = serialized.request;
      anthropicBeta = resolveRequestedBetas(
        c.req.header("anthropic-beta"),
        dependencies.allowedBetas,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      return errorResponse(c, 400, "invalid_request_error", "Invalid AI request");
    }
    if (c.req.path === MESSAGES_PATH && parsedBody.max_tokens === undefined) {
      return errorResponse(c, 400, "invalid_request_error", "Invalid AI request");
    }
    if (!dependencies.allowedModels.has(parsedBody.model)) {
      return errorResponse(c, 403, "permission_error", "This model is not enabled");
    }

    const runtime = parseFundedProxyApiKey(
      c.req.header("x-api-key") ?? "",
      dependencies.sharedSecret,
    );
    if (!runtime) return errorResponse(c, 401, "authentication_error", "Unauthorized");
    const headers = new Headers({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "cf-aig-authorization": `Bearer ${dependencies.gatewayToken}`,
      "cf-aig-collect-log-payload": "false",
      "cf-aig-zdr": "true",
      "cf-aig-metadata": JSON.stringify({
        runtime_id: opaqueRuntimeId(runtime.handle, dependencies.sharedSecret),
        access_source: "matrix_included",
      }),
    });
    if (anthropicBeta) headers.set("anthropic-beta", anthropicBeta);

    const firstResponseController = new AbortController();
    const firstResponseTimer = setTimeout(() => {
      firstResponseController.abort(new DOMException("AI first response timed out", "TimeoutError"));
    }, dependencies.firstResponseTimeoutMs);
    const fetchSignal = AbortSignal.any([
      state.lifetimeSignal,
      firstResponseController.signal,
    ]);

    try {
      const upstream = await fetchImpl(`${dependencies.gatewayBaseUrl}${c.req.path}`, {
        method: "POST",
        headers,
        body: requestBody,
        redirect: "error",
        signal: fetchSignal,
      });
      clearTimeout(firstResponseTimer);
      if (!upstream.ok) {
        void upstream.body?.cancel().catch((error: unknown) => {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          console.warn("[proxy] Funded AI rejected-response cleanup failed", { errorName });
        });
        if (upstream.status === 429) {
          return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
        }
        console.warn("[proxy] Funded AI upstream rejected request", { status: upstream.status });
        return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
      }
      if (!upstream.body) {
        return new Response(null, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
      }
      const responseBody = boundedBody(
        upstream.body,
        dependencies.maxResponseBytes,
        state.activeLease,
        (reason) => state.controller.abort(reason),
        state.lifetimeSignal,
      );
      state.handedOff = true;
      return new Response(responseBody, {
        status: upstream.status,
        headers: safeUpstreamHeaders(upstream),
      });
    } catch (error) {
      clearTimeout(firstResponseTimer);
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI upstream request failed", { errorName });
      if (isTimeoutSignal(firstResponseController.signal) || isTimeoutSignal(state.lifetimeSignal)) {
        return errorResponse(c, 504, "timeout_error", "AI access timed out");
      }
      return errorResponse(c, 502, "api_error", "AI access is temporarily unavailable");
    }
  };

  return {
    register(app) {
      app.use("/v1/*", async (c, next) => {
        const providedKey = c.req.header("x-api-key") ?? "";
        if (!isFundedProxyApiKey(providedKey)) return next();
        if (c.req.method !== "POST") {
          return errorResponse(c, 404, "not_found_error", "AI route not found");
        }
        const path = c.req.path;
        if (path !== MESSAGES_PATH && path !== COUNT_TOKENS_PATH) {
          return errorResponse(c, 404, "not_found_error", "AI route not found");
        }
        if (new URL(c.req.url).search !== "") {
          return errorResponse(c, 404, "not_found_error", "AI route not found");
        }
        if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
          return errorResponse(c, 415, "invalid_request_error", "Content-Type must be application/json");
        }

        const runtime = parseFundedProxyApiKey(providedKey, dependencies.sharedSecret);
        if (!runtime) return errorResponse(c, 401, "authentication_error", "Unauthorized");
        const runtimeId = opaqueRuntimeId(runtime.handle, dependencies.sharedSecret);
        const lease = admission.acquire(runtimeId);
        if (!lease) {
          return errorResponse(c, 429, "rate_limit_error", "AI capacity is temporarily limited");
        }

        const controller = new AbortController();
        activeRequests.add(controller);
        let released = false;
        const activeLease: AdmissionLease = {
          release: () => {
            if (released) return;
            released = true;
            activeRequests.delete(controller);
            lease.release();
          },
        };
        const state: ActiveRequestState = {
          activeLease,
          controller,
          lifetimeSignal: AbortSignal.any([
            c.req.raw.signal,
            controller.signal,
            AbortSignal.timeout(dependencies.timeoutMs),
          ]),
          handedOff: false,
        };
        requestStates.set(c, state);
        try {
          await next();
        } finally {
          requestStates.delete(c);
          if (!state.handedOff) activeLease.release();
        }
      });

      const createRequestBodyLimit = (maxSize: number) => bodyLimit({
        maxSize,
        onError: (c: Context) => errorResponse(
          c,
          413,
          "invalid_request_error",
          "AI request is too large",
        ),
      });
      const messageBodyLimit = createRequestBodyLimit(dependencies.maxBodyBytes);
      const countTokensBodyLimit = createRequestBodyLimit(
        Math.min(dependencies.maxBodyBytes, COUNT_TOKENS_BODY_LIMIT_BYTES),
      );
      app.use(MESSAGES_PATH, async (c, next) => {
        if (!requestStates.has(c)) return next();
        return messageBodyLimit(c, next);
      });
      app.use(COUNT_TOKENS_PATH, async (c, next) => {
        if (!requestStates.has(c)) return next();
        return countTokensBodyLimit(c, next);
      });
      app.all("/v1/*", async (c, next) => {
        const state = requestStates.get(c);
        if (!state) return next();
        return handler(c, state);
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
