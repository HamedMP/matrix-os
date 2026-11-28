import {
  buildPlatformRequest, isTimeoutError, noStoreTextHeaders, normalizeEdgeSecret, readRequestBody, withEdgeHeaders,
} from "./index.js";
import { managedTerminalCanaryOrigin, MANAGED_TERMINAL_CANARY_MARKER } from "./managed-terminal-canary.js";

interface CanaryWorkerEnv {
  DEFAULT_EDGE_ROUTER: Pick<Fetcher, "fetch">;
  EDGE_ROUTER_SECRET?: string;
  PLATFORM_ORIGIN: string;
  MATRIX_MANAGED_TERMINAL_EDGE_CANARY_V1?: string;
}

const CHAT_BODY_LIMIT = 128 * 1024;

function unavailable(status: number) {
  return new Response("upstream unavailable", { status, headers: noStoreTextHeaders() });
}

/** Install on this Chat's explicit VM path. The serving Edge Worker stays on its current deployment. */
export async function handleManagedTerminalCanary(request: Request, env: CanaryWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const config = env.MATRIX_MANAGED_TERMINAL_EDGE_CANARY_V1;
  if (!managedTerminalCanaryOrigin(request, url, config, env.PLATFORM_ORIGIN)) {
    return env.DEFAULT_EDGE_ROUTER.fetch(request);
  }
  const edgeSecret = normalizeEdgeSecret(env.EDGE_ROUTER_SECRET);
  if (!edgeSecret) return unavailable(503);
  const body = await readRequestBody(request, CHAT_BODY_LIMIT);
  if (body instanceof Response) return body;
  const origin = managedTerminalCanaryOrigin(request, url, config, env.PLATFORM_ORIGIN);
  if (!origin) return env.DEFAULT_EDGE_ROUTER.fetch(new Request(request, { body }));

  const upstream = buildPlatformRequest(request, origin + url.pathname + url.search, url.host, edgeSecret, body);
  upstream.headers.delete(MANAGED_TERMINAL_CANARY_MARKER);
  try {
    const response = await fetch(upstream, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return unavailable(502);
    }
    const result = withEdgeHeaders(response, "app", url.pathname);
    result.headers.set(MANAGED_TERMINAL_CANARY_MARKER, "candidate");
    return result;
  } catch (error: unknown) {
    const status = isTimeoutError(error) ? 504 : 502;
    console.warn("[terminal-canary] Candidate request failed", status);
    return unavailable(status);
  }
}

export default { fetch: handleManagedTerminalCanary };
