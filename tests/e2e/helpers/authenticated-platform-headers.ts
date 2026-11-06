export function authenticatedPlatformHeaders(input: {
  request: Parameters<typeof fetch>[0];
  headers?: HeadersInit;
  platformOrigin: string;
  cookieHeader: string;
}): Headers {
  const url = new URL(typeof input.request === "string" || input.request instanceof URL
    ? input.request
    : input.request.url);
  const headers = new Headers(input.headers);
  if (url.origin === input.platformOrigin) {
    headers.set("origin", input.platformOrigin);
    if (input.cookieHeader) headers.set("cookie", input.cookieHeader);
  }
  return headers;
}
