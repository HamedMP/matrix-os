/**
 * Total time a client gets to deliver a complete request (headers and body) to
 * the gateway or platform edge. Body-size caps bound memory; this bounds how
 * long a connection may stay open while a body arrives.
 *
 * Sized for the largest edge upload caps on slow links: a 10 MB upload needs
 * about 35 KB/s and a 100 MB internal sync object about 350 KB/s. It matches the
 * Node.js default, so making it explicit changes no accepted upload. Handler and
 * response time after the request is received are not counted.
 */
export const EDGE_REQUEST_TIMEOUT_MS = 300_000;
export const EDGE_HEADERS_TIMEOUT_MS = 60_000;

export interface EdgeRequestDeadlines {
  requestTimeoutMs: number;
  headersTimeoutMs: number;
}

interface DeadlineConfigurableServer {
  headersTimeout: number;
  requestTimeout: number;
}

export function configureEdgeRequestDeadlines(
  server: object,
  deadlines: EdgeRequestDeadlines = {
    requestTimeoutMs: EDGE_REQUEST_TIMEOUT_MS,
    headersTimeoutMs: EDGE_HEADERS_TIMEOUT_MS,
  },
): void {
  if (!("headersTimeout" in server) || !("requestTimeout" in server)) {
    throw new Error("Server does not expose HTTP request deadline controls");
  }
  const { requestTimeoutMs, headersTimeoutMs } = deadlines;
  if (
    !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0
    || !Number.isSafeInteger(headersTimeoutMs) || headersTimeoutMs <= 0
    || headersTimeoutMs > requestTimeoutMs
  ) {
    throw new Error("Request deadlines must be positive and headers must not outlast the request");
  }
  const configurable = server as DeadlineConfigurableServer;
  configurable.headersTimeout = headersTimeoutMs;
  configurable.requestTimeout = requestTimeoutMs;
}
