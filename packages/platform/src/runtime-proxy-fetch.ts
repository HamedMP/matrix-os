import {
  SITE_PUBLISH_PROXY_TIMEOUT_MS,
  SPEECH_DICTATION_MAX_BYTES,
  SPEECH_TRANSCRIPTION_PROXY_TIMEOUT_MS,
} from "@matrix-os/contracts";
import { APP_FILES_BRIDGE_PATH, MAX_APP_FILE_REQUEST_BYTES } from "@matrix-os/contracts/app-files";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { fetchWithStaleConnectionRetry } from "./customer-vps-dispatcher.js";

/**
 * Keep header waits bounded without timing out a healthy streaming body. Pooled
 * upstream sockets can go stale, so a body-less GET/HEAD is replayed once.
 */
export async function fetchRuntimeProxy(
  targetUrl: string,
  init: RequestInit,
  timeoutMs: number,
  releaseTimeoutAfterHeaders: boolean,
): Promise<Response> {
  // Sync commits include bounded staged-object validation/publication. Keep the
  // proxy alive beyond the gateway's four-minute budget, but below the CLI's six.
  const path = new URL(targetUrl).pathname;
  const operationTimeoutMs = init.method === "POST" && path === "/api/sync/commit"
    ? 300_000 : init.method === "POST" && /^\/api\/apps\/[a-z0-9][a-z0-9-]{0,63}\/site$/.test(path)
      ? SITE_PUBLISH_PROXY_TIMEOUT_MS
      // A long dictation transcribes for longer than the default proxy budget.
      : init.method === "POST" && path === "/api/speech/transcriptions"
        ? SPEECH_TRANSCRIPTION_PROXY_TIMEOUT_MS : timeoutMs;
  if (!releaseTimeoutAfterHeaders) {
    const deadline = AbortSignal.timeout(operationTimeoutMs);
    const upstreamSignal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetchWithStaleConnectionRetry(fetch, targetUrl, { ...init, signal: upstreamSignal });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstreamSignal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return await fetchWithStaleConnectionRetry(fetch, targetUrl, { ...init, signal: upstreamSignal });
  } finally {
    clearTimeout(timeout);
  }
}

export function shouldReleaseRuntimeProxyTimeout(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/files/media" || path === "/api/chats/events");
}

// Bare, `/vm/<handle>`, and `/vm/<handle>/~runtime/<slot>` forms of the same upload.
const RUNTIME_PREFIX = "(?:\\/vm\\/[a-z0-9][a-z0-9-]{0,62}(?:\\/~runtime\\/[a-z0-9][a-z0-9_-]{0,79})?)?";
const SPEECH_UPLOAD_PATH = new RegExp(`^${RUNTIME_PREFIX}\\/api\\/speech\\/transcriptions$`);
const APP_FILE_PATH = new RegExp(`^${RUNTIME_PREFIX}\\/api\\/bridge\\/files$`);

/**
 * Largest request body the session proxy forwards. Two requests are larger
 * than the general limit, and only their exact paths get more room: a
 * ten-minute dictation, and the save of a document from Docs or Sheets (a
 * file of up to 10 MiB as base64 in a JSON envelope). The gateway and the
 * speech service still enforce the recording and file policies.
 */
export function runtimeProxyBodyLimitBytes(method: string, path: string, defaultBytes: number): number {
  if (method !== "POST") return defaultBytes;
  if (SPEECH_UPLOAD_PATH.test(path)) return Math.max(defaultBytes, SPEECH_DICTATION_MAX_BYTES + 64 * 1024);
  if (APP_FILE_PATH.test(path)) return Math.max(defaultBytes, MAX_APP_FILE_REQUEST_BYTES);
  return defaultBytes;
}

/**
 * The body limit of the session proxy, as a middleware. Each exception to the
 * general limit has its own bound, so a document save never gets the larger
 * dictation limit.
 */
export function runtimeProxyBodyLimit(defaultBytes: number): MiddlewareHandler {
  const general = bodyLimit({ maxSize: defaultBytes });
  // One middleware per exception, built once: the set is fixed and small.
  const exceptions = ["/api/speech/transcriptions", APP_FILES_BRIDGE_PATH].map((path) => {
    const maxSize = runtimeProxyBodyLimitBytes("POST", path, defaultBytes);
    return { maxSize, limit: bodyLimit({ maxSize }) };
  });
  return (context, next) => {
    const maxSize = runtimeProxyBodyLimitBytes(context.req.method, context.req.path, defaultBytes);
    const exception = maxSize > defaultBytes ? exceptions.find((candidate) => candidate.maxSize === maxSize) : undefined;
    return (exception?.limit ?? general)(context, next);
  };
}
