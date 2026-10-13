import type { FundedOpenAiRequest } from "./funded-relay-openai-request.js";

export const FundedUpstreamKind = {
  cloudflareAnthropic: "cloudflare_anthropic",
  cloudflareWorkersAi: "cloudflare_workers_ai",
  awsBedrock: "aws_bedrock",
} as const;

export type FundedUpstreamKind = typeof FundedUpstreamKind[keyof typeof FundedUpstreamKind];

/** Content-free server-side evidence. Never serialize this object to callers. */
export interface FundedUpstreamProvenance {
  upstream: FundedUpstreamKind;
  routeId: string;
  resolvedModel: string;
  inferenceProfile?: string;
  region?: string;
  pricingVersion: string;
  providerRequestId?: string;
}

export interface FundedUpstreamDispatchInput {
  request: FundedOpenAiRequest;
  requestId: string;
  signal: AbortSignal;
}

export interface FundedUpstreamDispatchResult {
  response: Response;
  provenance: FundedUpstreamProvenance;
}

/** A provider-neutral dispatch boundary. Authorization and settlement stay in the relay. */
export interface FundedGenerationUpstream {
  dispatch(input: FundedUpstreamDispatchInput): Promise<FundedUpstreamDispatchResult>;
  close(): void;
}
