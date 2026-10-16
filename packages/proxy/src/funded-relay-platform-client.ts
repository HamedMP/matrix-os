import {
  FundedAiAuthorizationResponseSchema,
  FundedAiTerminalOutcomeResponseSchema, type FundedAiTerminalOutcomeRequest, type FundedAiTerminalOutcomeResponse,
  FundedAiFinalizationResponseSchema,
  FundedAiPolicyCheckResponseSchema,
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

export class FundedControlPlaneError extends Error {
  constructor(readonly status: number, readonly priorityReason?: FundedAiPriorityReason,
    readonly fundingReason?: "insufficient_credit" | "budget_exceeded",
    readonly safeCode?: FundedAiSafeError["error"]["code"]) {
    super("Funded AI control-plane request failed");
    this.name = "FundedControlPlaneError";
  }
}

function safeErrorFrom(text: string): FundedAiSafeError["error"] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch (error: unknown) { if (error instanceof SyntaxError) return undefined; throw error; }
  const safe = FundedAiSafeErrorSchema.safeParse(parsed);
  return safe.success ? safe.data.error : undefined;
}

/** These are platform contract errors, never arbitrary provider error strings. */
function fundingReasonFrom(status: number, safe: FundedAiSafeError["error"] | undefined):
  "insufficient_credit" | "budget_exceeded" | undefined {
  if (status !== 402 && status !== 403) return undefined;
  if (status === 402 && safe?.code === "insufficient_credit") return "insufficient_credit";
  if (status === 403 && safe?.code === "budget_exceeded") return "budget_exceeded";
  return undefined;
}

/** Only the platform's allowlisted priority reasons pass through; anything else is dropped. */
function priorityReasonFrom(safe: FundedAiSafeError["error"] | undefined): FundedAiPriorityReason | undefined {
  return safe?.code === "rate_limited" ? safe.reason : undefined;
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
    action: "authorize" | "check" | "finalize" | "release" | "start" | "terminal",
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
      const safeError = safeErrorFrom(text);
      throw new FundedControlPlaneError(response.status,
        response.status === 429 ? priorityReasonFrom(safeError) : undefined,
        fundingReasonFrom(response.status, safeError), safeError?.code);
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
