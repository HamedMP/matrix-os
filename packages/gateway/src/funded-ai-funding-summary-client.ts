import {
  FundedAiRuntimeFundingSummaryResponseSchema,
  type FundedAiFundingSummary,
} from "@matrix-os/contracts";
import type { FundedAiRuntimeConfig } from "./funded-ai-credential-manager.js";

const MAX_RESPONSE_BYTES = 16 * 1024;
const SAFE_MESSAGE = "Matrix AI usage is temporarily unavailable";

export interface FundedAiFundingSummaryReader {
  getFundingSummary(options?: { signal?: AbortSignal }): Promise<FundedAiFundingSummary>;
}

export class FundedAiFundingSummaryClientError extends Error {
  constructor() {
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

async function readBoundedJson(response: Response): Promise<unknown> {
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
  dependencies: {
    fetchFn?: typeof fetch;
    makeTimeoutSignal?: (ms: number) => AbortSignal;
  } = {},
): FundedAiFundingSummaryReader {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const makeTimeoutSignal = dependencies.makeTimeoutSignal ?? AbortSignal.timeout;
  return {
    async getFundingSummary(options = {}) {
      const timeout = makeTimeoutSignal(config.requestTimeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await fetchFn(config.fundingSummaryUrl, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${config.runtimeAuthToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: "{}",
        });
        if (!response.ok) {
          await cancelResponse(response);
          throw new FundedAiFundingSummaryClientError();
        }
        const parsed = FundedAiRuntimeFundingSummaryResponseSchema.safeParse(
          await readBoundedJson(response),
        );
        if (!parsed.success) throw new FundedAiFundingSummaryClientError();
        return parsed.data.funding;
      } catch (error) {
        if (error instanceof FundedAiFundingSummaryClientError) throw error;
        console.warn(
          "[funded-ai-funding] Summary request failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        throw new FundedAiFundingSummaryClientError();
      }
    },
  };
}
