import { createCanonicalPhaseReadiness, type CanonicalPhaseReadinessOptions } from "./chat/canonical-phase-readiness.js";
import {
  FundedAiSafeErrorSchema,
  FundedAiRuntimeFundingSummaryResponseSchema,
  FundedAiRuntimeChatFundingSummaryResponseSchema,
  FundedAiUpstreamPreferenceResponseSchema,
  type FundedAiChatAvailability,
  type FundedAiRuntimeFundingSummaryResponse,
  type FundedAiUpstreamPreferenceValue,
  type FundedAiUpstreamPreferenceView,
} from "@matrix-os/contracts";
import type { FundedAiRuntimeConfig } from "./funded-ai-credential-manager.js";

const MAX_RESPONSE_BYTES = 16 * 1024;
const SAFE_MESSAGE = "Matrix AI usage is temporarily unavailable";

export interface FundedAiFundingSummaryReader {
  getFundingSummary(options?: { signal?: AbortSignal }): Promise<
    Pick<FundedAiRuntimeFundingSummaryResponse, "funding" | "policy"> & {
      chatAvailability?: FundedAiChatAvailability;
      upstreamPreference?: FundedAiUpstreamPreferenceView;
    }
  >;
  setUpstreamPreference?(input: {
    idempotencyKey: string;
    expectedRevision: number;
    selectedUpstream: FundedAiUpstreamPreferenceValue;
    signal?: AbortSignal;
  }): Promise<FundedAiUpstreamPreferenceView>;
}

export class FundedAiFundingSummaryClientError extends Error {
  constructor(readonly code: "revision_conflict" | "unavailable" = "unavailable") {
    super(SAFE_MESSAGE);
    this.name = "FundedAiFundingSummaryClientError";
  }
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch((error: unknown) => {
    console.warn(
      "[funded-ai-funding] response cancellation failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  });
}

export async function readBoundedFundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancelResponse(response);
    throw new FundedAiFundingSummaryClientError();
  }
  if (!response.body) throw new FundedAiFundingSummaryClientError();
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
          console.warn(
            "[funded-ai-funding] response cancellation failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
        });
        throw new FundedAiFundingSummaryClientError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.warn(
        "[funded-ai-funding] Response JSON parsing failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    throw new FundedAiFundingSummaryClientError();
  }
}

export function createFundedAiFundingSummaryClient(
  config: FundedAiRuntimeConfig,
  dependencies: CanonicalPhaseReadinessOptions & {
    fetchFn?: typeof fetch;
    makeTimeoutSignal?: (ms: number) => AbortSignal;
  } = {},
): FundedAiFundingSummaryReader {
  const scope = createCanonicalPhaseReadiness(config.isolatedChat, dependencies);
  const fetchFn = dependencies.fetchFn ?? fetch;
  const makeTimeoutSignal = dependencies.makeTimeoutSignal ?? AbortSignal.timeout;
  const preferenceUrl = new URL(config.fundingSummaryUrl);
  preferenceUrl.pathname = preferenceUrl.pathname.replace(/\/funding-summary$/, "/upstream-preference");
  return {
    async getFundingSummary(options = {}) {
      const phaseHeaders = scope.requestHeaders(config);
      const timeout = makeTimeoutSignal(config.requestTimeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const request = (body: string) => fetchFn(config.fundingSummaryUrl, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${config.runtimeAuthToken}`,
            "content-type": "application/json",
            accept: "application/json",
            ...phaseHeaders,
          },
          body,
        });
        let response = await request(JSON.stringify({ includeChatAvailability: true, includeUpstreamPreference: true }));
        // Negotiate one field at a time so a gateway update cannot disable
        // Chat against a platform that understands Chat availability but not
        // the newer preference projection. Every attempt shares one deadline.
        if (response.status === 400) {
          const rejection = FundedAiSafeErrorSchema.safeParse(await readBoundedFundedJson(response));
          if (!rejection.success || rejection.data.error.code !== "invalid_request") {
            throw new FundedAiFundingSummaryClientError();
          }
          signal.throwIfAborted();
          response = await request(JSON.stringify({ includeChatAvailability: true }));
        }
        // Only ordinary reads may fall all the way back to the legacy shape.
        // Canonical reads require the Chat projection and retain their binding
        // headers on the negotiated attempt above.
        if (response.status === 400 && !scope.canonical) {
          const rejection = FundedAiSafeErrorSchema.safeParse(await readBoundedFundedJson(response));
          if (!rejection.success || rejection.data.error.code !== "invalid_request") {
            throw new FundedAiFundingSummaryClientError();
          }
          signal.throwIfAborted();
          response = await request("{}");
        }
        if (!response.ok) {
          await cancelResponse(response);
          throw new FundedAiFundingSummaryClientError();
        }
        const raw = await readBoundedFundedJson(response);
        if (typeof raw === "object" && raw !== null && "chatAvailability" in raw) {
          const parsed = FundedAiRuntimeChatFundingSummaryResponseSchema.safeParse(raw);
          if (!parsed.success) throw new FundedAiFundingSummaryClientError();
          return { funding: parsed.data.funding, policy: parsed.data.policy,
            chatAvailability: parsed.data.chatAvailability,
            ...(parsed.data.upstreamPreference ? { upstreamPreference: parsed.data.upstreamPreference } : {}) };
        }
        const parsed = FundedAiRuntimeFundingSummaryResponseSchema.safeParse(raw);
        if (!parsed.success) throw new FundedAiFundingSummaryClientError();
        return { funding: parsed.data.funding, policy: parsed.data.policy };
      } catch (error) {
        if (error instanceof FundedAiFundingSummaryClientError) throw error;
        console.warn(
          "[funded-ai-funding] Summary request failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        throw new FundedAiFundingSummaryClientError();
      }
    },
    async setUpstreamPreference(input) {
      const timeout = makeTimeoutSignal(config.requestTimeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      try {
        const response = await fetchFn(preferenceUrl.toString(), {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${config.runtimeAuthToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision,
            selectedUpstream: input.selectedUpstream }),
        });
        if (!response.ok) {
          if (response.status === 409) {
            const rejection = FundedAiSafeErrorSchema.safeParse(await readBoundedFundedJson(response));
            if (rejection.success && rejection.data.error.code === "revision_conflict") {
              throw new FundedAiFundingSummaryClientError("revision_conflict");
            }
          } else {
            await cancelResponse(response);
          }
          throw new FundedAiFundingSummaryClientError();
        }
        const parsed = FundedAiUpstreamPreferenceResponseSchema.safeParse(await readBoundedFundedJson(response));
        if (!parsed.success) throw new FundedAiFundingSummaryClientError();
        return parsed.data.preference;
      } catch (error) {
        if (error instanceof FundedAiFundingSummaryClientError) throw error;
        console.warn("[funded-ai-funding] Preference request failed:",
          error instanceof Error ? error.name : "UnknownError");
        throw new FundedAiFundingSummaryClientError();
      }
    },
  };
}
