import { getGatewayUrl, getGatewayWs } from "./gateway";

const WS_AUTH_PATH = "/api/auth/ws-token";
const WS_TOKEN_REFRESH_SKEW_MS = 30_000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let inflightTokenRequest: Promise<string | null> | null = null;

interface WsTokenResponse {
  token?: unknown;
  expiresAt?: unknown;
}

function getCachedToken(now = Date.now()): string | null {
  if (!cachedToken) {
    return null;
  }
  if (cachedExpiresAt - WS_TOKEN_REFRESH_SKEW_MS <= now) {
    cachedToken = null;
    cachedExpiresAt = 0;
    return null;
  }
  return cachedToken;
}

async function fetchWebSocketToken(): Promise<string | null> {
  const res = await fetch(`${getGatewayUrl()}${WS_AUTH_PATH}`, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return null;
  }
  const body = await res.json() as WsTokenResponse;
  if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
    return null;
  }
  cachedToken = body.token;
  cachedExpiresAt = body.expiresAt;
  return body.token;
}

export async function getWebSocketAuthToken(): Promise<string | null> {
  const cached = getCachedToken();
  if (cached) {
    return cached;
  }
  if (!inflightTokenRequest) {
    inflightTokenRequest = fetchWebSocketToken().finally(() => {
      inflightTokenRequest = null;
    });
  }
  return inflightTokenRequest;
}

export async function buildAuthenticatedWebSocketUrl(
  path: string,
  query?: Record<string, string | undefined>,
): Promise<string> {
  const gatewayUrl = new URL(getGatewayWs());
  gatewayUrl.pathname = path;
  gatewayUrl.search = "";

  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      gatewayUrl.searchParams.set(key, value);
    }
  }

  const token = await getWebSocketAuthToken();
  if (token) {
    gatewayUrl.searchParams.set("token", token);
  }

  return gatewayUrl.toString();
}

export function resetWebSocketAuthTokenCacheForTests(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  inflightTokenRequest = null;
}
