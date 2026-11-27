import {
  FundedAiAuthorizationResponseSchema,
  FundedAiTerminalOutcomeResponseSchema, type FundedAiTerminalOutcomeRequest, type FundedAiTerminalOutcomeResponse,
  FundedAiFinalizationResponseSchema,
  FundedAiPolicyCheckResponseSchema,
  FundedAiPricingReviewSnapshotSchema,
  FundedAiPricingRouteFailureSchema,
  FundedAiReleaseResponseSchema,
  FundedAiSafeErrorSchema,
  FundedAiStartResponseSchema,
  FUNDED_AI_UPSTREAM_SELECTION_VERSION,
  type FundedAiAuthorizationResponse,
  type FundedAiPriorityReason,
  type FundedAiFinalizationRequest,
  type FundedAiFinalizationResponse,
  type FundedAiPolicyCheckResponse,
  type FundedAiReleaseResponse,
  type FundedAiSafeError,
  type FundedAiStartResponse,
  type FundedAiResolvedUpstream,
  type FundedAiUpstreamSelection,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import {
  normalizeFundedPlatformOrigin,
  type FundedRelayConfig,
} from "./funded-relay-config.js";

/** The platform's funded busy refusal: when to come back, as both a header value and a timestamp. */
export interface FundedBusyRetry {
  retryAfterSeconds: number;
  retryAt: string;
}

export class FundedControlPlaneError extends Error {
  constructor(readonly status: number, readonly priorityReason?: FundedAiPriorityReason,
    readonly fundingReason?: "insufficient_credit" | "budget_exceeded", readonly identityDenied = false,
    readonly busy?: FundedBusyRetry,
    readonly safeCode?: FundedAiSafeError["error"]["code"]) {
    super("Funded AI control-plane request failed");
    this.name = "FundedControlPlaneError";
  }
}

/** The relay's answer to a platform busy refusal: the validated retry time, as a header and in the body. */
export function fundedBusyResponse(busy: FundedBusyRetry): Response {
  return Response.json({
    type: "error", error: { type: "api_error", code: "busy", message: "Matrix AI is busy; try again later", retryAt: busy.retryAt },
  }, { status: 503, headers: { "retry-after": String(busy.retryAfterSeconds) } });
}

const MAX_RETRY_AFTER_SECONDS = 2 * 24 * 60 * 60;

/** Only a 503 with a bounded integer Retry-After counts as busy (ENG-520 P7, from PR #3437). */
function busyRetryAfter(status: number, retryAfter: string | null): number | undefined {
  if (status !== 503 || retryAfter === null || !/^[0-9]{1,6}$/.test(retryAfter)) return undefined;
  const seconds = Number(retryAfter);
  return seconds > MAX_RETRY_AFTER_SECONDS ? undefined : seconds;
}

/** Only allowlisted Platform contract errors affect Relay retry and quota handling. */
function controlErrorFrom(status: number, text: string, retryAfter: string | null = null): FundedControlPlaneError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return new FundedControlPlaneError(status);
    throw error;
  }
  const safe = FundedAiSafeErrorSchema.safeParse(parsed);
  if (!safe.success) return new FundedControlPlaneError(status);
  const detail = safe.data.error;
  switch (detail.code) {
    case "rate_limited":
      return new FundedControlPlaneError(status, status === 429 ? detail.reason : undefined);
    case "insufficient_credit":
      return new FundedControlPlaneError(status, undefined, status === 402 ? detail.code : undefined);
    case "budget_exceeded":
      return new FundedControlPlaneError(status, undefined, status === 403 ? detail.code : undefined);
    case "unauthorized":
      return new FundedControlPlaneError(status, undefined, undefined, status === 401);
    case "access_disabled":
    case "model_not_allowed":
      return new FundedControlPlaneError(status, undefined, undefined, status === 403);
    case "busy": {
      // A busy refusal passes through only with a contract-valid body and a bounded Retry-After.
      const retryAfterSeconds = busyRetryAfter(status, retryAfter);
      return retryAfterSeconds === undefined ? new FundedControlPlaneError(status)
        : new FundedControlPlaneError(status, undefined, undefined, false, { retryAfterSeconds, retryAt: detail.retryAt });
    }
    case "invalid_request":
      return new FundedControlPlaneError(status, undefined, undefined, false, undefined, detail.code);
    default:
      return new FundedControlPlaneError(status);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await response.body?.cancel("control response too large");
    throw new Error("Funded AI control response exceeded its limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel("control response too large");
        throw new Error("Funded AI control response exceeded its limit");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

export interface FundedPlatformClient {
  check(input: { credential: string; modelId: string }, signal: AbortSignal): Promise<FundedAiPolicyCheckResponse>;
  authorize(input: {
    credential: string;
    requestId: string;
    modelId: string;
    maxCostMicrousd: number;
    billingMode?: "usage";
    billingPolicy?: "postpaid";
    jevPricingVersion?: string;
    upstream?: FundedAiResolvedUpstream;
    upstreamSelection?: FundedAiUpstreamSelection;
  }, signal: AbortSignal): Promise<FundedAiAuthorizationResponse>;
  start(input: { reservationId: string; tokenId: string; executionId?: string }, signal: AbortSignal): Promise<FundedAiStartResponse>;
  release(input: {
    reservationId: string;
    tokenId: string;
    reason: "pre_upstream_failure";
  }, signal: AbortSignal): Promise<FundedAiReleaseResponse>;
  terminal(input: FundedAiTerminalOutcomeRequest, signal: AbortSignal): Promise<FundedAiTerminalOutcomeResponse>;
  finalize(input: FundedAiFinalizationRequest, signal: AbortSignal): Promise<FundedAiFinalizationResponse>;
}

type ControlAction = "authorize" | "check" | "finalize" | "release" | "start" | "terminal"
  | "pricing-reviews" | "pricing-route-failure";

export function createFundedPlatformClient(options: Pick<
  FundedRelayConfig,
  "platformBaseUrl" | "relayControlToken" | "platformTimeoutMs" | "maxControlResponseBytes"
> & { fetch: typeof fetch }): FundedPlatformClient & {
  readPricingReviews(signal: AbortSignal): Promise<z.output<typeof FundedAiPricingReviewSnapshotSchema>>;
  reportPricingRouteFailure(input: z.input<typeof FundedAiPricingRouteFailureSchema>, signal: AbortSignal): Promise<void>;
} {
  const platformBaseUrl = normalizeFundedPlatformOrigin(options.platformBaseUrl);
  const relayControlToken = options.relayControlToken;
  const platformTimeoutMs = options.platformTimeoutMs;
  const maxControlResponseBytes = options.maxControlResponseBytes;
  const fetchImpl = options.fetch;

  function request(action: ControlAction, body: unknown, lifetimeSignal: AbortSignal) {
    const isPricingRead = action === "pricing-reviews";
    return fetchImpl(`${platformBaseUrl}/internal/ai/funded/${action}`, {
      method: isPricingRead ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${relayControlToken}`,
        ...(isPricingRead ? {} : { "content-type": "application/json" }),
      },
      ...(isPricingRead ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([lifetimeSignal, AbortSignal.timeout(platformTimeoutMs)]),
    });
  }

  async function call<T>(action: Exclude<ControlAction, "pricing-route-failure">, body: unknown, schema: z.ZodType<T>,
    lifetimeSignal: AbortSignal): Promise<T> {
    const response = await request(action, body, lifetimeSignal);
    const text = await readBoundedText(response, maxControlResponseBytes);
    if (!response.ok) throw controlErrorFrom(response.status, text, response.headers.get("retry-after"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Funded AI control response was invalid");
      throw error;
    }
    return schema.parse(parsed);
  }

  return {
    readPricingReviews: (signal) => call("pricing-reviews", undefined, FundedAiPricingReviewSnapshotSchema, signal),
    async reportPricingRouteFailure(input, signal) {
      const response = await request("pricing-route-failure", FundedAiPricingRouteFailureSchema.parse(input), signal);
      if (response.status !== 204) {
        await response.body?.cancel("unexpected route-failure acknowledgement");
        throw new FundedControlPlaneError(response.status);
      }
    },
    check: async (input, signal) => {
      try {
        return await call("check", { ...input, upstreamSelectionVersion: FUNDED_AI_UPSTREAM_SELECTION_VERSION },
          FundedAiPolicyCheckResponseSchema, signal);
      } catch (error) {
        if (!(error instanceof FundedControlPlaneError)
          || error.status !== 400 || error.safeCode !== "invalid_request") throw error;
        // A strict pre-capability platform rejects the extra field before any
        // policy mutation. Retry its legacy read-only shape and keep Bedrock disabled.
        return call("check", input, FundedAiPolicyCheckResponseSchema, signal);
      }
    },
    authorize: (input, signal) => call("authorize", input, FundedAiAuthorizationResponseSchema, signal),
    start: (input, signal) => call("start", input, FundedAiStartResponseSchema, signal),
    release: (input, signal) => call("release", input, FundedAiReleaseResponseSchema, signal),
    terminal: (input, signal) => call("terminal", input, FundedAiTerminalOutcomeResponseSchema, signal),
    finalize: (input, signal) => call("finalize", input, FundedAiFinalizationResponseSchema, signal),
  };
}
