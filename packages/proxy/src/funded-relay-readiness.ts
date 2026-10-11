import { randomUUID } from "node:crypto";
import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";
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
export async function probeFundedModel(config: FundedRelayConfig, modelId: string, fetchFn: typeof fetch = fetch,
  diagnostic: { probeId?: string; traceId?: string } = {}): Promise<boolean> {
  const startedAt = Date.now();
  const probeId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(diagnostic.probeId ?? "")
    ? diagnostic.probeId!.toLowerCase() : randomUUID();
  const traceId = /^[a-f0-9]{32}$/.test(diagnostic.traceId ?? "") ? diagnostic.traceId : undefined;
  const finish = (outcome: "ready" | "upstream_http" | "invalid_response" | "timeout" | "aborted" | "transport_error", upstreamStatus?: number): boolean => {
    console.info(JSON.stringify({ event: "funded_readiness_upstream", modelId, probeId,
      ...(traceId ? { traceId } : {}), outcome,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}), elapsedMs: Math.max(0, Date.now() - startedAt) }));
    return outcome === "ready";
  };
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
    // Match ordinary managed turns: omission selects provider max reasoning,
    // which can exceed the health budget even for a one-token generation.
    body = JSON.stringify({ model: FUNDED_GLM_FLASH, messages: [{ role: "user", content: "ping" }],
      max_tokens: 1, store: false, reasoning_effort: "low" });
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
    const response = await fetchFn(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(FUNDED_AI_READINESS_TIMEOUTS.relayUpstreamProbeMs) });
    if (!response.ok) {
      await response.body?.cancel();
      return finish("upstream_http", response.status);
    }
    const responseBody = await boundedJson(response);
    if (!responseBody || typeof responseBody !== "object") return finish("invalid_response", response.status);
    if (modelId === FUNDED_SONNET) return finish("type" in responseBody && responseBody.type === "message"
      && "model" in responseBody && responseBody.model === "claude-sonnet-5"
      && "content" in responseBody && Array.isArray(responseBody.content) ? "ready" : "invalid_response", response.status);
    const envelope = responseBody as { success?: unknown; result?: unknown };
    if ("success" in envelope && envelope.success !== true) return finish("invalid_response", response.status);
    const result = envelope.success === true ? envelope.result : responseBody;
    return finish(!!result && typeof result === "object" && "model" in result && result.model === FUNDED_GLM_FLASH
      && "choices" in result && Array.isArray(result.choices) && result.choices.length > 0 ? "ready" : "invalid_response", response.status);
  } catch (error) {
    const name = error instanceof Error && ["TimeoutError", "AbortError", "SyntaxError"].includes(error.name) ? error.name : "UnknownError";
    console.warn("[funded-ai] Model readiness probe unavailable:", name);
    return finish(name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : name === "SyntaxError" ? "invalid_response" : "transport_error");
  }
}
