import { getGatewayUrl, getGatewayWs } from "./gateway";
import { isSelfHostedDocument } from "./self-host-mode";

const WS_AUTH_PATH = "/api/auth/ws-token";
const WS_TOKEN_REFRESH_SKEW_MS = 30_000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let cachedGatewayUrl: string | null = null;
let inflightTokenRequest: Promise<string | null> | null = null;
let inflightGatewayUrl: string | null = null;

interface WsTokenResponse {
  token?: unknown;
  expiresAt?: unknown;
}

export class WebSocketCredentialUnavailableError extends Error {
  constructor() {
    super("WebSocket credential unavailable");
    this.name = "WebSocketCredentialUnavailableError";
  }
}

function getCachedToken(gatewayUrl: string, now = Date.now()): string | null {
  if (!cachedToken || cachedGatewayUrl !== gatewayUrl) {
    return null;
  }
  if (cachedExpiresAt - WS_TOKEN_REFRESH_SKEW_MS <= now) {
    cachedToken = null;
    cachedExpiresAt = 0;
    cachedGatewayUrl = null;
    return null;
  }
  return cachedToken;
}

async function fetchWebSocketToken(gatewayUrl: string): Promise<string | null> {
  const res = await fetch(`${gatewayUrl}${WS_AUTH_PATH}`, {
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
  cachedGatewayUrl = gatewayUrl;
  return body.token;
}

export async function getWebSocketAuthToken(): Promise<string | null> {
  const gatewayUrl = getGatewayUrl();
  const cached = getCachedToken(gatewayUrl);
  if (cached) {
    return cached;
  }
  if (!inflightTokenRequest || inflightGatewayUrl !== gatewayUrl) {
    inflightGatewayUrl = gatewayUrl;
    const request = fetchWebSocketToken(gatewayUrl).finally(() => {
      if (inflightTokenRequest === request) {
        inflightTokenRequest = null;
        inflightGatewayUrl = null;
      }
    });
    inflightTokenRequest = request;
  }
  return inflightTokenRequest;
}

export async function buildAuthenticatedWebSocketUrl(
  path: string,
  query?: Record<string, string | undefined>,
  options?: { requireToken?: boolean },
): Promise<string> {
  const gatewayUrl = new URL(getGatewayWs());
  const explicitComputerPrefix = gatewayUrl.pathname.replace(/\/ws\/?$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  gatewayUrl.pathname = `${explicitComputerPrefix}${normalizedPath}`;
  gatewayUrl.search = "";

  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      gatewayUrl.searchParams.set(key, value);
    }
  }

  if (isSelfHostedDocument()) {
    return gatewayUrl.toString();
  }

  const token = await getWebSocketAuthToken();
  if (!token && options?.requireToken) {
    throw new WebSocketCredentialUnavailableError();
  }
  if (token) {
    gatewayUrl.searchParams.set("token", token);
  }

  return gatewayUrl.toString();
}

export function resetWebSocketAuthTokenCacheForTests(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  cachedGatewayUrl = null;
  inflightTokenRequest = null;
  inflightGatewayUrl = null;
}
