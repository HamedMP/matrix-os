import {
  SITE_PUBLISH_PROXY_TIMEOUT_MS,
  SPEECH_DICTATION_MAX_BYTES,
  SPEECH_TRANSCRIPTION_PROXY_TIMEOUT_MS,
} from "@matrix-os/contracts";
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

const SPEECH_UPLOAD_PATH = /^(?:\/vm\/[a-z0-9][a-z0-9-]{0,62})?\/api\/speech\/transcriptions$/;

/**
 * Largest request body the session proxy forwards. A ten-minute dictation is
 * larger than the general limit, so only its exact upload path gets more room;
 * the gateway and the speech service still enforce the recording policy.
 */
export function runtimeProxyBodyLimitBytes(method: string, path: string, defaultBytes: number): number {
  return method === "POST" && SPEECH_UPLOAD_PATH.test(path)
    ? Math.max(defaultBytes, SPEECH_DICTATION_MAX_BYTES + 64 * 1024)
    : defaultBytes;
}
