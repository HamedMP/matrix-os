import { prepareAppAiRequest } from "./app-ai-request";
import {
  APP_FILES_BRIDGE_PATH, APP_FILE_TIMEOUT_MS, AppFileErrorBodySchema, AppFileInputSchema, AppFileListReplySchema, AppFileMkdirReplySchema,
  AppFileReadReplySchema, AppFileStatReplySchema, AppFileWriteReplySchema, MAX_APP_FILE_REQUEST_BYTES, appFileReplyBytes, appFileRequestBytes,
  type AppFileKind,
} from "@matrix-os/contracts/app-files";
import type { z } from "zod/v4";
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
  if (url === APP_FILES_BRIDGE_PATH) return APP_FILE_TIMEOUT_MS;
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
  if (request?.url === APP_FILES_BRIDGE_PATH) return readAppFileResponse(response, request.init);
  return readBoundedJson(response, replyBytes(request));
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
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
  if (url === APP_FILES_BRIDGE_PATH) return { url, init: prepareAppFileRequest(app, init) };
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

// ---------------------------------------------------------------- app files

/** Kind of each bound file request, so the reply can be bounded without re-parsing a large body. */
const appFileRequestKinds = new WeakMap<RequestInit, AppFileKind>();
const APP_FILE_REPLY_SCHEMAS: Record<AppFileKind, z.ZodType> = {
  "files.list": AppFileListReplySchema,
  "files.stat": AppFileStatReplySchema,
  "files.read": AppFileReadReplySchema,
  "files.write": AppFileWriteReplySchema,
  "files.mkdir": AppFileMkdirReplySchema,
};

function utf8BytesWithin(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return false;
  return text.length * 3 <= maxBytes || new TextEncoder().encode(text).length <= maxBytes;
}

/**
 * Binds the trusted app identity to a file request. The app sends only the
 * input; any `app` it names is dropped. Only a write may use the large body cap.
 */
export function prepareAppFileRequest(app: string, init: RequestInit): RequestInit {
  AppIdentitySchema.parse(app);
  if (init.method !== "POST" || typeof init.body !== "string" || !utf8BytesWithin(init.body, MAX_APP_FILE_REQUEST_BYTES)) {
    throw new Error("Invalid app file request");
  }
  const raw: unknown = JSON.parse(init.body);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid app file request");
  const candidate: Record<string, unknown> = { ...raw };
  delete candidate.app;
  const input = AppFileInputSchema.parse(candidate);
  const maxBytes = appFileRequestBytes(input.kind);
  const body = JSON.stringify({ app, input });
  if (!utf8BytesWithin(init.body, maxBytes) || !utf8BytesWithin(body, maxBytes)) throw new Error("Invalid app file request");
  const bound: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body };
  appFileRequestKinds.set(bound, input.kind);
  return bound;
}

function appFileKindOf(init: RequestInit): AppFileKind {
  const known = appFileRequestKinds.get(init);
  if (known) return known;
  if (typeof init.body !== "string") throw new Error("Invalid app file request");
  const parsed: unknown = JSON.parse(init.body);
  if (!parsed || typeof parsed !== "object" || !("input" in parsed)) throw new Error("Invalid app file request");
  return AppFileInputSchema.parse(parsed.input).kind;
}

/**
 * A success reply must match the reply schema of its kind; anything else is
 * refused. A failure reply passes on only as the contract's error body; the
 * frame maps a missing body to a code by status.
 */
async function readAppFileResponse(response: Response, init: RequestInit): Promise<unknown> {
  const kind = appFileKindOf(init);
  if (!response.ok) {
    try {
      const failure = AppFileErrorBodySchema.safeParse(await readBoundedJson(response, MAX_APP_BRIDGE_REPLY_BYTES));
      return failure.success ? failure.data : null;
    } catch (error: unknown) {
      console.warn("[app-bridge] file error body unavailable", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }
  return APP_FILE_REPLY_SCHEMAS[kind].parse(await readBoundedJson(response, appFileReplyBytes(kind)));
}
