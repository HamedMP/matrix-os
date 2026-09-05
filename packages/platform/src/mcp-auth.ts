import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod/v4";

export interface McpPrincipal {
  userId: string;
  clientId: string;
  /** OAuth access-token expiry, in epoch seconds. */
  expiresAt: number;
}

export class McpAuthError extends Error {
  readonly status: 401 | 403;
  constructor(readonly code: "invalid_token" | "insufficient_scope") {
    super(code === "invalid_token" ? "Invalid access token" : "Insufficient scope");
    this.name = "McpAuthError";
    this.status = code === "invalid_token" ? 401 : 403;
  }
}

interface McpTokenVerifierOptions {
  issuer: string;
  resourceUrl: string;
  jwksUrl: string;
  fetch?: typeof fetch;
}

const MAX_JWKS_BYTES = 65_536;
const scopeToken = z.string().min(1).max(256).regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);
const scopes = z.array(scopeToken).min(1).max(64);
const keySet = z.object({
  keys: z.array(z.object({
    kty: z.literal("RSA"),
    n: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/),
    e: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
    kid: z.string().min(1).max(256).optional(),
    alg: z.string().max(32).optional(),
    use: z.string().max(32).optional(),
    key_ops: z.array(z.string().max(32)).max(8).optional(),
    // Private keys are not a valid public verification key set.
    d: z.never().optional(),
  }).passthrough()).min(1).max(32),
});

function trustedUrl(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || url.hash || url.search) {
    throw new Error("Invalid MCP authentication configuration");
  }
  return url;
}

function requireScope(payload: { scope?: unknown; scp?: unknown }): void {
  const fromString = payload.scope === undefined ? undefined
    : scopes.safeParse(typeof payload.scope === "string" ? payload.scope.split(" ") : undefined);
  const fromArray = payload.scp === undefined ? undefined : scopes.safeParse(payload.scp);
  if ((!fromString && !fromArray) || (fromString && !fromString.success) || (fromArray && !fromArray.success)) {
    throw new McpAuthError("insufficient_scope");
  }
  const stringScopes = fromString?.success ? fromString.data : undefined;
  const arrayScopes = fromArray?.success ? fromArray.data : undefined;
  if (stringScopes && arrayScopes && (stringScopes.some((s) => !arrayScopes.includes(s))
    || arrayScopes.some((s) => !stringScopes.includes(s)))) {
    throw new McpAuthError("insufficient_scope");
  }
  if (!(stringScopes ?? arrayScopes)?.includes("matrix:computer")) throw new McpAuthError("insufficient_scope");
}

async function boundedJwks(response: Response): Promise<Response> {
  if (response.status !== 200 || Number(response.headers.get("content-length")) > MAX_JWKS_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("Invalid JWKS response");
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_JWKS_BYTES);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_JWKS_BYTES - length) throw new Error("JWKS response too large");
      buffer.set(value, length);
      length += value.byteLength;
    }
    const parsed = keySet.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
    return Response.json(parsed);
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

/** Dedicated OAuth access tokens only; never reuse Clerk session or sync-token verification. */
export function createMcpTokenVerifier(options: McpTokenVerifierOptions): (token: string) => Promise<McpPrincipal> {
  trustedUrl(options.issuer);
  trustedUrl(options.resourceUrl);
  const jwksUrl = trustedUrl(options.jwksUrl);
  const fetchImpl = options.fetch ?? fetch;
  // One fixed issuer/JWKS per verifier. jose replaces the cache on refresh and coalesces fetches;
  // our key/body caps bound both the cached JSON and imported CryptoKeys (RS256 only).
  const jwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 10_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 300_000,
    [customFetch]: async (_url, init) => boundedJwks(await fetchImpl(jwksUrl.href, {
      ...init, redirect: "error", signal: AbortSignal.timeout(10_000),
    })),
  });
  return async (token) => {
    if (!token || token.length > 16_384) throw new McpAuthError("invalid_token");
    try {
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ["RS256"], issuer: options.issuer, audience: options.resourceUrl,
        requiredClaims: ["exp", "iat", "sub", "client_id"],
      });
      const now = Math.floor(Date.now() / 1000);
      if (payload.aud !== options.resourceUrl || "sid" in payload
        || typeof payload.sub !== "string" || !/^user_[A-Za-z0-9]{1,128}$/.test(payload.sub)
        || typeof payload.client_id !== "string" || !/^[\x21-\x7E]{1,256}$/.test(payload.client_id)
        || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
        || payload.iat! > now || payload.exp! <= payload.iat!) {
        throw new McpAuthError("invalid_token");
      }
      requireScope({ scope: payload.scope, scp: payload.scp });
      return { userId: payload.sub, clientId: payload.client_id, expiresAt: payload.exp! };
    } catch (error) {
      if (error instanceof McpAuthError) throw error;
      if (error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired
        || error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid
        || error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed
        || error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JOSENotSupported) {
        throw new McpAuthError("invalid_token");
      }
      // Provider outages/malformed keys are not evidence that the caller's credentials are bad.
      // The route logs a coarse service failure and returns 503, without token/error details.
      throw new Error("MCP authentication service unavailable", { cause: error });
    }
  };
}
