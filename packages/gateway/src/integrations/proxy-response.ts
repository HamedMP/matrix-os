const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const DECODED_FETCH_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);

export function createIntegrationProxyResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  for (const header of HOP_BY_HOP_RESPONSE_HEADERS) {
    headers.delete(header);
  }
  for (const header of DECODED_FETCH_RESPONSE_HEADERS) {
    headers.delete(header);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
