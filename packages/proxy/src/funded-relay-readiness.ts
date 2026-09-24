import type { FundedRelayConfig } from "./funded-relay-config.js";
import { FUNDED_GLM_FLASH } from "./funded-relay-model.js";

export const FUNDED_SONNET = "anthropic/claude-sonnet-5";
const MAX_PROBE_BODY_BYTES = 64 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROBE_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } finally {
    reader.releaseLock();
  }
}

/** An authenticated, no-inference model probe for the exact paid route. */
export async function probeFundedModel(config: FundedRelayConfig, modelId: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  let url: string;
  let headers: Record<string, string>;
  if (modelId === FUNDED_GLM_FLASH && config.workersAiToken && config.reservationMode === "usage") {
    const accountId = new URL(config.gatewayBaseUrl).pathname.split("/")[2];
    url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?search=glm-5.3-flash&per_page=10`;
    headers = { authorization: `Bearer ${config.workersAiToken}` };
  } else if (modelId === FUNDED_SONNET) {
    url = `${config.gatewayBaseUrl}/v1/models/claude-sonnet-5`;
    headers = {
      "cf-aig-authorization": `Bearer ${config.gatewayToken}`,
      "anthropic-version": "2023-06-01",
    };
  } else return false;

  try {
    const response = await fetchFn(url, { headers, redirect: "error", signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body = await boundedJson(response);
    if (!body || typeof body !== "object") return false;
    if (modelId === FUNDED_SONNET) return "id" in body && body.id === "claude-sonnet-5";
    const catalog = body as { success?: unknown; result?: unknown };
    return catalog.success === true && Array.isArray(catalog.result)
      && catalog.result.some((item: unknown) => item !== null && typeof item === "object"
        && "name" in item && item.name === FUNDED_GLM_FLASH);
  } catch (error) {
    console.warn("[funded-ai] Model readiness probe unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}
