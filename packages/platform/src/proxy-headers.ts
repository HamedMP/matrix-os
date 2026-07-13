const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const DECODED_FETCH_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
]);

export function sanitizeProxyResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const header of HOP_BY_HOP_RESPONSE_HEADERS) {
    sanitized.delete(header);
  }
  for (const header of DECODED_FETCH_RESPONSE_HEADERS) {
    sanitized.delete(header);
  }
  return sanitized;
}

export function applyNoStoreResponseHeaders(headers: Headers): void {
  headers.set('cache-control', 'no-store, private');
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('expires', '0');
}
