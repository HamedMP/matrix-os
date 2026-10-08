import {
  FundedAiAuthorizationResponseSchema,
  FundedAiFinalizationResponseSchema,
  FundedAiPolicyCheckResponseSchema,
  FundedAiReleaseResponseSchema,
  FundedAiSafeErrorSchema,
  FundedAiStartResponseSchema,
  type FundedAiAuthorizationResponse,
  type FundedAiPriorityReason,
  type FundedAiFinalizationRequest,
  type FundedAiFinalizationResponse,
  type FundedAiPolicyCheckResponse,
  type FundedAiReleaseResponse,
  type FundedAiStartResponse,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import {
  normalizeFundedPlatformOrigin,
  type FundedRelayConfig,
} from "./funded-relay-config.js";

export class FundedControlPlaneError extends Error {
  constructor(readonly status: number, readonly priorityReason?: FundedAiPriorityReason,
    readonly fundingReason?: "insufficient_credit" | "budget_exceeded") {
    super("Funded AI control-plane request failed");
    this.name = "FundedControlPlaneError";
  }
}

/** These are platform contract errors, never arbitrary provider error strings. */
function fundingReasonFrom(status: number, text: string): "insufficient_credit" | "budget_exceeded" | undefined {
  if (status !== 402 && status !== 403) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch (error: unknown) { if (error instanceof SyntaxError) return undefined; throw error; }
  const safe = FundedAiSafeErrorSchema.safeParse(parsed);
  if (!safe.success) return undefined;
  if (status === 402 && safe.data.error.code === "insufficient_credit") return "insufficient_credit";
  if (status === 403 && safe.data.error.code === "budget_exceeded") return "budget_exceeded";
  return undefined;
}

/** Only the platform's allowlisted priority reasons pass through; anything else is dropped. */
function priorityReasonFrom(text: string): FundedAiPriorityReason | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const safe = FundedAiSafeErrorSchema.safeParse(parsed);
  return safe.success && safe.data.error.code === "rate_limited" ? safe.data.error.reason : undefined;
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
    jevPricingVersion?: string;
  }, signal: AbortSignal): Promise<FundedAiAuthorizationResponse>;
  start(input: { reservationId: string; tokenId: string }, signal: AbortSignal): Promise<FundedAiStartResponse>;
  release(input: {
    reservationId: string;
    tokenId: string;
    reason: "pre_upstream_failure";
  }, signal: AbortSignal): Promise<FundedAiReleaseResponse>;
  finalize(input: FundedAiFinalizationRequest, signal: AbortSignal): Promise<FundedAiFinalizationResponse>;
}

export function createFundedPlatformClient(options: Pick<
  FundedRelayConfig,
  "platformBaseUrl" | "relayControlToken" | "platformTimeoutMs" | "maxControlResponseBytes"
> & { fetch: typeof fetch }): FundedPlatformClient {
  const platformBaseUrl = normalizeFundedPlatformOrigin(options.platformBaseUrl);
  const relayControlToken = options.relayControlToken;
  const platformTimeoutMs = options.platformTimeoutMs;
  const maxControlResponseBytes = options.maxControlResponseBytes;
  const fetchImpl = options.fetch;

  async function call<T>(
    action: "authorize" | "check" | "finalize" | "release" | "start",
    body: unknown,
    schema: z.ZodType<T>,
    lifetimeSignal: AbortSignal,
  ): Promise<T> {
    const response = await fetchImpl(`${platformBaseUrl}/internal/ai/funded/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayControlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([lifetimeSignal, AbortSignal.timeout(platformTimeoutMs)]),
    });
    const text = await readBoundedText(response, maxControlResponseBytes);
    if (!response.ok) {
      throw new FundedControlPlaneError(response.status, response.status === 429 ? priorityReasonFrom(text) : undefined,
        fundingReasonFrom(response.status, text));
    }
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
    check: (input, signal) => call("check", input, FundedAiPolicyCheckResponseSchema, signal),
    authorize: (input, signal) => call("authorize", input, FundedAiAuthorizationResponseSchema, signal),
    start: (input, signal) => call("start", input, FundedAiStartResponseSchema, signal),
    release: (input, signal) => call("release", input, FundedAiReleaseResponseSchema, signal),
    finalize: (input, signal) => call("finalize", input, FundedAiFinalizationResponseSchema, signal),
  };
}
