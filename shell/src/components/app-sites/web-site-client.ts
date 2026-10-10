import { getGatewayUrl } from "../../lib/gateway";
import { createSiteClient, SiteClientError, type SiteTransport } from "../../lib/site-client";
const MAX_RESPONSE_BYTES = 1_048_576;
async function request(path: string, method: string, value: unknown, options: { signal: AbortSignal; timeoutMs?: number }): Promise<Response> {
  const response = await fetch(`${getGatewayUrl()}${path}`, {
    method, credentials: "include", headers: { accept: "application/json", ...(value === undefined ? {} : { "content-type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
  });
  if (!response.ok) throw new SiteClientError(response.status);
  return response;
}
async function bytes(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SiteClientError(413);
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
async function json<T>(path: string, method: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<T> {
  if (!options) throw new SiteClientError(503);
  const response = await request(path, method, value, options);
  if (response.status === 204) return undefined as T;
  return JSON.parse(new TextDecoder().decode(await bytes(response))) as T;
}
const transport: SiteTransport = {
  get: (path, options) => json(path, "GET", undefined, options),
  post: (path, value, options) => json(path, "POST", value, options),
  patch: (path, value, options) => json(path, "PATCH", value, options),
  delete: (path, value, options) => json(path, "DELETE", value, options),
  getBlob: async (path, options) => {
    if (!options) throw new SiteClientError(503);
    return new Blob([await bytes(await request(path, "GET", undefined, options))]);
  },
  getText: async (path, options) => {
    if (!options) throw new SiteClientError(503);
    return new TextDecoder().decode(await bytes(await request(path, "GET", undefined, options)));
  },
};
export const webSiteClient = createSiteClient(transport);
