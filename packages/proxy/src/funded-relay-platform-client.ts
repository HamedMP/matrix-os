import {
  FundedAiAuthorizationResponseSchema,
  FundedAiPolicyCheckResponseSchema,
  FundedAiReleaseResponseSchema,
  FundedAiStartResponseSchema,
  type FundedAiAuthorizationResponse,
  type FundedAiPolicyCheckResponse,
  type FundedAiReleaseResponse,
  type FundedAiStartResponse,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import type { FundedRelayConfig } from "./funded-relay-config.js";

export class FundedControlPlaneError extends Error {
  constructor(readonly status: number) {
    super("Funded AI control-plane request failed");
    this.name = "FundedControlPlaneError";
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
  }, signal: AbortSignal): Promise<FundedAiAuthorizationResponse>;
  start(input: { reservationId: string; tokenId: string }, signal: AbortSignal): Promise<FundedAiStartResponse>;
  release(input: {
    reservationId: string;
    tokenId: string;
    reason: "pre_upstream_failure";
  }, signal: AbortSignal): Promise<FundedAiReleaseResponse>;
}

export function createFundedPlatformClient(options: Pick<
  FundedRelayConfig,
  "platformBaseUrl" | "relayControlToken" | "platformTimeoutMs" | "maxControlResponseBytes"
> & { fetch: typeof fetch }): FundedPlatformClient {
  async function call<T>(
    action: "authorize" | "check" | "release" | "start",
    body: unknown,
    schema: z.ZodType<T>,
    lifetimeSignal: AbortSignal,
  ): Promise<T> {
    const response = await options.fetch(`${options.platformBaseUrl}/internal/ai/funded/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.relayControlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([lifetimeSignal, AbortSignal.timeout(options.platformTimeoutMs)]),
    });
    const text = await readBoundedText(response, options.maxControlResponseBytes);
    if (!response.ok) throw new FundedControlPlaneError(response.status);
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
  };
}
