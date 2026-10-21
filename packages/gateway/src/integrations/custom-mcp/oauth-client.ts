import { CustomMcpBrokerError, type CustomMcpCredential } from "./broker.js";
import type { pinnedOAuthRequest } from "./oauth-request.js";

export type OAuthClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";
export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  /** OAuth registration epoch seconds; zero means no expiry. */
  clientSecretExpiresAt?: number;
  tokenEndpointAuthMethod?: OAuthClientAuthMethod;
}

const boundedToken = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);

export function selectOAuthClientAuthMethod(methods: unknown): OAuthClientAuthMethod {
  // Older public servers omit the advertisement. Preserve their existing flow.
  if (methods === undefined) return "none";
  if (!Array.isArray(methods) || methods.length > 20 || !methods.every(x => typeof x === "string" && x.length <= 100)) {
    throw new CustomMcpBrokerError("upstream");
  }
  for (const method of ["none", "client_secret_basic", "client_secret_post"] as const) {
    if (methods.includes(method)) return method;
  }
  throw new CustomMcpBrokerError("oauth_client_setup_required");
}

export async function registerOAuthClient(options: {
  endpoint?: string; methods?: unknown; redirectUri: string; signal?: AbortSignal;
  request: typeof pinnedOAuthRequest;
}): Promise<OAuthClientRegistration> {
  if (!options.endpoint) throw new CustomMcpBrokerError("oauth_client_setup_required");
  const method = selectOAuthClientAuthMethod(options.methods);
  const response = await options.request({
    method: "POST", url: options.endpoint, signal: options.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Matrix OS", redirect_uris: [options.redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: method, application_type: "web" }),
  });
  if ([400, 401, 403, 404, 405].includes(response.status)) throw new CustomMcpBrokerError("oauth_client_setup_required");
  if (response.status !== 201 || !response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
    throw new CustomMcpBrokerError("upstream");
  }
  const body = response.body as Record<string, unknown>;
  const returnedMethod = body.token_endpoint_auth_method ?? method;
  const expiry = body.client_secret_expires_at;
  if (expiry !== undefined && (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry < 0 || expiry > 8_640_000_000_000)) {
    throw new CustomMcpBrokerError("upstream");
  }
  if (!boundedToken(body.client_id, 2048) || returnedMethod !== method
    || (method === "none" ? body.client_secret !== undefined : !boundedToken(body.client_secret, 8192))) {
    throw new CustomMcpBrokerError("upstream");
  }
  return { clientId: body.client_id, ...(method !== "none" ? { clientSecret: body.client_secret as string, ...(expiry !== undefined ? { clientSecretExpiresAt: expiry as number } : {}), tokenEndpointAuthMethod: method } : {}) };
}

/** Secret-bearing data is used only for the issuer's pinned token/revocation endpoint. */
export function oauthClientRequest(fields: Record<string, string>, oauth?: CustomMcpCredential["oauth"]): {
  headers: Record<string, string>; body: string;
} {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const form = new URLSearchParams(fields);
  const method = oauth?.tokenEndpointAuthMethod ?? "none";
  if (method !== "none") {
    if (!oauth?.clientIssuer || !boundedToken(oauth.clientId, 2048) || !boundedToken(oauth.clientSecret, 8192)) {
      throw new CustomMcpBrokerError("action_required");
    }
    if (method === "client_secret_post") form.set("client_secret", oauth.clientSecret);
    else if (method === "client_secret_basic") {
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
      headers.authorization = `Basic ${Buffer.from(`${encode(oauth.clientId)}:${encode(oauth.clientSecret)}`).toString("base64")}`;
      form.delete("client_id");
    } else throw new CustomMcpBrokerError("action_required");
  } else if (oauth?.clientSecret !== undefined) throw new CustomMcpBrokerError("action_required");
  return { headers, body: form.toString() };
}
