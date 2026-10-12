import { prepareAppAiRequest } from "./app-ai-request";
import { AppCapabilityInputSchema, AppIdentitySchema, MAX_APP_CAPABILITY_BYTES, MAX_APP_BRIDGE_REPLY_BYTES, MAX_APP_RESPONSE_CHUNKS, MAX_APP_DATABASE_REPLY_BYTES, MAX_APP_DATABASE_REQUEST_BYTES, MAX_APP_KV_REQUEST_BYTES, appCapabilityReplyBytes, APP_CAPABILITY_TIMEOUT_MS } from "@matrix-os/contracts";

/** Requests supplied by apps never choose the authenticated app identity. */
export function prepareAppCapabilityRequest(app: string, init: RequestInit): RequestInit {
  AppIdentitySchema.parse(app);
  if (init.method !== "POST" || typeof init.body !== "string" || new TextEncoder().encode(init.body).length > MAX_APP_CAPABILITY_BYTES) {
    throw new Error("Invalid app capability request");
  }
  const raw = JSON.parse(init.body);
  // Compatibility clients may carry an app hint; ignore it in the trusted host.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid app capability request");
  const input = { ...raw };
  delete input.app;
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app, input: AppCapabilityInputSchema.parse(input) }) };
}

export { MAX_APP_BRIDGE_REPLY_BYTES };
export function appBridgeTimeoutMs(url: string): number {
  const galleryInstall = /^\/api\/app-gallery\/[a-z][a-z0-9-]{0,47}\/install$/.test(url);
  return galleryInstall || url === "/api/bridge/ai" || url.startsWith("/api/bridge/ai/routes?") || url === "/api/bridge/capabilities" ? APP_CAPABILITY_TIMEOUT_MS : 10_000;
}
function replyBytes(request?: {url:string;init:RequestInit}): number {
  if (request?.url === "/api/bridge/query" || request?.url === "/api/bridge/data") return MAX_APP_DATABASE_REPLY_BYTES;
  if (request?.url === "/api/bridge/capabilities" && typeof request.init.body === "string") {
    return appCapabilityReplyBytes(AppCapabilityInputSchema.parse(JSON.parse(request.init.body).input));
  }
  return MAX_APP_BRIDGE_REPLY_BYTES;
}

/** Bound the body while reading, rather than buffering an unlimited JSON reply. */
export async function readAppBridgeResponse(response: Response, request?: {url:string;init:RequestInit}): Promise<unknown> {
  const maxBytes = replyBytes(request);
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error("App response unavailable");
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let chunks = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes || ++chunks > MAX_APP_RESPONSE_CHUNKS) throw new Error("App response unavailable");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch((error: unknown) => console.warn("[app-bridge] response reader unavailable", error instanceof Error ? error.name : "UnknownError"));
  }
}


export function prepareAppBridgeFetch(app: string, url: string, init: RequestInit): { url: string; init: RequestInit } {
  if (url === "/api/bridge/ai") return { url, init: prepareAppAiRequest(app, init) };
  if (url === "/api/bridge/ai/routes") return { url: `${url}?app=${encodeURIComponent(AppIdentitySchema.parse(app))}`, init: { method: "GET" } };
  if (url === "/api/bridge/capabilities") return { url, init: prepareAppCapabilityRequest(app, init) };
  if (url === "/api/bridge/service") {
    let input: unknown = { kind: "integrations.list" };
    if (init.method === "POST") {
      if (typeof init.body !== "string" || new TextEncoder().encode(init.body).length > MAX_APP_CAPABILITY_BYTES) throw new Error("Invalid app request");
      const value = JSON.parse(init.body);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid app request");
      const call = { ...value };
      delete call.app;
      input = { ...call, kind: "integrations.call" };
    } else if (init.method && init.method !== "GET") throw new Error("Invalid app request");
    return { url: "/api/bridge/capabilities", init: prepareAppCapabilityRequest(app, { method: "POST", body: JSON.stringify(input) }) };
  }
  if (url === "/api/bridge/query" || url === "/api/bridge/data") {
    const maxBytes = url === "/api/bridge/query" ? MAX_APP_DATABASE_REQUEST_BYTES : MAX_APP_KV_REQUEST_BYTES;
    if (init.method !== "POST" || typeof init.body !== "string" || new TextEncoder().encode(init.body).length > maxBytes) throw new Error("Invalid app request");
    const value = JSON.parse(init.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid app request");
    const body = JSON.stringify({ ...value, app: AppIdentitySchema.parse(app) });
    if (new TextEncoder().encode(body).length > maxBytes) throw new Error("Invalid app request");
    return { url, init: { method: "POST", headers: { "content-type": "application/json" }, body } };
  }
  return { url, init };
}
