import { Agent } from "undici";

/**
 * Outbound connection pool for platform -> customer VPS traffic (shell proxy,
 * collaboration relay, probes). Each VPS is a fixed public IPv4 behind nginx,
 * so a warm pooled TLS connection saves a full TCP + TLS handshake per request.
 *
 * The `pipelining: 0` + 1 ms keep-alive this replaces was copied from the Docker container
 * dispatcher, whose upstream addresses churn on every container restart. A VPS
 * origin does not churn that way: it is torn down with the machine. The idle
 * window stays far inside nginx's default 75 s keepalive_timeout so the edge
 * never closes a socket the platform is about to reuse, and the residual case
 * (VPS reboot, edge restart, network reset) is covered by a single retry of
 * idempotent requests in `fetchWithStaleConnectionRetry`.
 */
export const CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS = 10_000;
/** Upper bound for a server-advertised `Keep-Alive: timeout=` hint. */
export const CUSTOMER_VPS_KEEP_ALIVE_MAX_TIMEOUT_MS = 30_000;
/** Per-origin (per-VPS) socket cap; idle origins are dropped once their sockets close. */
export const CUSTOMER_VPS_MAX_CONNECTIONS_PER_ORIGIN = 64;

export function createCustomerVpsProxyDispatcher(options: { verifyTls: boolean }): Agent {
  return new Agent({
    // undici treats pipelining 0 as "no keep-alive"; 1 is one in-flight request per reused socket.
    pipelining: 1,
    keepAliveTimeout: CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: CUSTOMER_VPS_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: CUSTOMER_VPS_MAX_CONNECTIONS_PER_ORIGIN,
    connect: { rejectUnauthorized: options.verifyTls },
  });
}

const STALE_CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

function staleConnectionCode(error: unknown): string | null {
  // fetch reports transport failures as a TypeError whose cause carries the socket code.
  if (!(error instanceof TypeError)) return null;
  const cause: unknown = error.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
  const code = (cause as { code: unknown }).code;
  return typeof code === "string" && STALE_CONNECTION_CODES.has(code) ? code : null;
}

export function isStaleConnectionError(error: unknown): boolean {
  return staleConnectionCode(error) !== null;
}

/**
 * Replays an idempotent, body-less request once when the pooled connection it
 * used turns out to be dead. fetch only rejects before response headers, so a
 * replay can never duplicate a response the caller already started reading.
 * Requests with a body, Request objects, non-idempotent methods, and aborted
 * requests are never replayed.
 */
export async function fetchWithStaleConnectionRetry(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error: unknown) {
    const method = (init.method ?? "GET").toUpperCase();
    const code = staleConnectionCode(error);
    // A Request object may carry its own (already consumed) body, so it is never replayed.
    if (input instanceof Request || (method !== "GET" && method !== "HEAD") || init.body != null
      || init.signal?.aborted || !code) throw error;
    console.warn("[customer-vps-dispatcher] retrying idempotent request after stale connection", code);
    return fetchImpl(input, init);
  }
}
