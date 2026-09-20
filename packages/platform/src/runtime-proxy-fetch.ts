/** Keep header waits bounded without timing out a healthy streaming body. */
export async function fetchRuntimeProxy(
  targetUrl: string,
  init: RequestInit,
  timeoutMs: number,
  releaseTimeoutAfterHeaders: boolean,
): Promise<Response> {
  // Sync commits include bounded staged-object validation/publication. Keep the
  // proxy alive beyond the gateway's four-minute budget, but below the CLI's six.
  const operationTimeoutMs = init.method === "POST" && new URL(targetUrl).pathname === "/api/sync/commit"
    ? 300_000 : timeoutMs;
  if (!releaseTimeoutAfterHeaders) {
    return fetch(targetUrl, { ...init, signal: AbortSignal.timeout(operationTimeoutMs) });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function shouldReleaseRuntimeProxyTimeout(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/files/media" || path === "/api/chats/events");
}
