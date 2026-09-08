/** Keep header waits bounded without timing out a healthy streaming body. */
export async function fetchRuntimeProxy(
  targetUrl: string,
  init: RequestInit,
  timeoutMs: number,
  releaseTimeoutAfterHeaders: boolean,
): Promise<Response> {
  if (!releaseTimeoutAfterHeaders) {
    return fetch(targetUrl, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
