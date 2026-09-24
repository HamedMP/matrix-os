import type { FundedRelayConfig } from "./funded-relay-config.js";
import { FUNDED_GLM_FLASH } from "./funded-relay-model.js";
import { workersAiTarget } from "./funded-relay-openai-request.js";

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

/** A minimal generation on the same upstream route and credential as paid traffic. */
export async function probeFundedModel(config: FundedRelayConfig, modelId: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  let url: string;
  let headers: Record<string, string>;
  let body: string;
  if (modelId === FUNDED_GLM_FLASH && config.workersAiToken && config.reservationMode === "usage") {
    const target = workersAiTarget(config.gatewayBaseUrl);
    url = target.url;
    headers = {
      authorization: `Bearer ${config.workersAiToken}`,
      "cf-aig-gateway-id": target.gatewayId,
      "cf-aig-collect-log-payload": "false",
      "content-type": "application/json",
    };
    body = JSON.stringify({ model: FUNDED_GLM_FLASH, messages: [{ role: "user", content: "ping" }], max_tokens: 1, store: false });
  } else if (modelId === FUNDED_SONNET) {
    url = `${config.gatewayBaseUrl}/v1/messages`;
    headers = {
      "cf-aig-authorization": `Bearer ${config.gatewayToken}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
  } else return false;

  try {
    const response = await fetchFn(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const responseBody = await boundedJson(response);
    if (!responseBody || typeof responseBody !== "object") return false;
    if (modelId === FUNDED_SONNET) return "type" in responseBody && responseBody.type === "message"
      && "model" in responseBody && responseBody.model === "claude-sonnet-5"
      && "content" in responseBody && Array.isArray(responseBody.content);
    const envelope = responseBody as { success?: unknown; result?: unknown };
    if ("success" in envelope && envelope.success !== true) return false;
    const result = envelope.success === true ? envelope.result : responseBody;
    return !!result && typeof result === "object" && "model" in result && result.model === FUNDED_GLM_FLASH
      && "choices" in result && Array.isArray(result.choices) && result.choices.length > 0;
  } catch (error) {
    console.warn("[funded-ai] Model readiness probe unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}
