import { setImmediate as yieldRead } from "node:timers/promises";
import { z } from "zod/v4";
import { gatewayAuthHeaders, type GatewayFetcher } from "./integrations.js";
import { wrapExternalContent } from "../security/external-content.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const NameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const CallIntegrationReadInputSchema = z.strictObject({
  service: NameSchema,
  action: NameSchema,
  label: z.string().trim().min(1).max(100),
  params: z.record(z.string().max(128), z.json()).optional(),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_REQUEST_BYTES - 512);

/** A scoped presentation never inherits the host bearer or broad integration paths. */
export function createScopedIntegrationReadFetcher(fetcher: GatewayFetcher = fetch): GatewayFetcher {
  return async (rawUrl, init) => {
    const token = process.env.MATRIX_AGENT_INTEGRATIONS_TOKEN;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("IntegrationReadCapabilityUnavailable");
    const url = new URL(rawUrl);
    const base = new URL(process.env.GATEWAY_URL ?? "http://localhost:4000");
    if (url.origin !== base.origin || url.search || url.hash
      || !((init.method === "GET" && ["/api/integrations", "/api/integrations/agent-catalog"].includes(url.pathname))
        || (init.method === "POST" && url.pathname === "/api/integrations/read-call"))) throw new Error("IntegrationReadPathDenied");
    const signal = init.signal ?? AbortSignal.timeout(35_000);
    const response = await fetcher(url.toString(), { ...init, headers: gatewayAuthHeaders(), redirect: "error", signal });
    if (!(response instanceof Response)) throw new Error("IntegrationReadResponseUnavailable");
    if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, json: async () => ({}), text: async () => "" }; }
    if (!response.body) throw new Error("IntegrationReadResponseUnavailable");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await response.body.cancel(); throw new Error("IntegrationReadResponseTooLarge"); }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(error => console.warn("[integration-read] cleanup failed", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", cancel, { once: true });
    let size = 0;
    let chunkCount = 0;
    const chunks: Uint8Array[] = [];
    try {
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        if (++chunkCount > 16_384) { await reader.cancel(); throw new Error("IntegrationReadResponseTooFragmented"); }
        if (chunkCount % 256 === 0) { await yieldRead(); signal.throwIfAborted(); }
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("IntegrationReadResponseTooLarge"); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      return { ok: true, status: response.status, json: async () => parsed, text: async () => text };
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  };
}

/** Use only the dedicated read broker; it validates risk and exact owner account. */
export async function callIntegrationReadHandler(input: unknown, fetcher: GatewayFetcher) {
  const failure = () => ({ isError: true, content: [{ type: "text" as const, text: "Integration read is unavailable. Check the selected connected account and read action, then retry." }] });
  try {
    const parsed = CallIntegrationReadInputSchema.parse(input);
    const response = await fetcher(`${process.env.GATEWAY_URL ?? "http://localhost:4000"}/api/integrations/read-call`, {
      method: "POST", headers: gatewayAuthHeaders(), body: JSON.stringify(parsed), redirect: "error", signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) return failure();
    const data = await response.json();
    return { content: [{ type: "text" as const, text: wrapExternalContent(JSON.stringify(data, null, 2), { source: "api", includeWarning: true }) }] };
  } catch (error) {
    console.warn("[integration-read] read failed", error instanceof Error ? error.name : "UnknownError");
    return failure();
  }
}
