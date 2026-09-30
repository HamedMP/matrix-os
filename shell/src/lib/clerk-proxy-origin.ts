import { getConfiguredAppOrigin } from "./public-origin";

/**
 * Clerk derives handshake destinations before the application auth callback.
 * Give it the configured browser origin while keeping Next's network URL and
 * local HTTP transport intact. Only this request's authentication sees these
 * headers; neither the caller nor the subsequent Next hop keeps them.
 */
export async function withClerkPublicOrigin<T>(
  request: { headers: Headers },
  authenticate: () => T | Promise<T>,
): Promise<T> {
  const origin = getConfiguredAppOrigin();
  if (!origin) return authenticate();
  const url = new URL(origin);
  const saved: ReadonlyArray<readonly [string, string | null]> = [
    ["x-forwarded-host", request.headers.get("x-forwarded-host")],
    ["x-forwarded-proto", request.headers.get("x-forwarded-proto")],
  ];
  request.headers.set("x-forwarded-host", url.host);
  request.headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
  try {
    const response = await authenticate();
    // Clerk decorates successful Next responses with request overrides. Keep
    // its signed auth metadata, but restore transport headers for Next's own
    // internal self-proxy so it never tries TLS against localhost:3200.
    if (response instanceof Response) {
      for (const [name, value] of saved) {
        const override = `x-middleware-request-${name}`;
        if (!response.headers.has(override)) continue;
        if (value === null) response.headers.delete(override);
        else response.headers.set(override, value);
      }
    }
    return response;
  } finally {
    for (const [name, value] of saved) {
      if (value === null) request.headers.delete(name);
      else request.headers.set(name, value);
    }
  }
}
