import { createRemoteJWKSet, customFetch, decodeJwt, decodeProtectedHeader, errors, jwtVerify } from "jose";
import { z } from "zod/v4";
import { isPilotCohortMember, type PilotCohortPolicy } from '@matrix-os/contracts';

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
  pilotCohortPolicy?: PilotCohortPolicy;
  issuer: string;
  resourceUrl: string;
  jwksUrl: string;
  /** Every scope the access token must grant; defaults to `matrix:computer`. */
  requiredScopes?: readonly string[];
  fetch?: typeof fetch;
}

export const DEFAULT_MCP_REQUIRED_SCOPES: readonly string[] = ["matrix:computer"];
/** RFC 9068 access-token type; Clerk signs OAuth access-token JWTs with it (`application/` prefix optional). */
const OAUTH_ACCESS_TOKEN_TYP = "at+jwt";
/** Clerk's signed `cat` header for session and M2M JWTs (mirrors @clerk/backend). */
const NON_OAUTH_CATEGORIES = new Map([["cl_B7d4PD111AAA", "session"], ["cl_B7d4PD333AAA", "m2m"]]);
/** Clerk's default verification clock skew, for nbf/iat only; expiry is enforced without skew. */
const CLOCK_TOLERANCE_SECONDS = 5;
const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DIAGNOSTICS_PER_MINUTE = 30;

type RejectReason = "malformed" | "opaque_token" | "token_type" | "token_category" | "algorithm" | "signature"
  | "unknown_key" | "expired" | "not_yet_valid" | "issuer" | "audience" | "claims" | "scope";

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

/** Parses `MATRIX_MCP_REQUIRED_SCOPES` (space/comma separated); unset or blank means the default. */
export function parseMcpRequiredScopes(raw: string | undefined): string[] {
  if (raw !== undefined && raw.length > 4096) throw new Error("Invalid MCP configuration");
  const unique = [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean))];
  if (unique.length === 0) return [...DEFAULT_MCP_REQUIRED_SCOPES];
  if (unique.length > 16 || !unique.every((scope) => scopeToken.safeParse(scope).success)) {
    throw new Error("Invalid MCP configuration");
  }
  return unique;
}

class Rejection extends Error {
  constructor(readonly reason: RejectReason, readonly code: McpAuthError["code"] = "invalid_token") {
    super(reason);
  }
}

function requireScope(payload: { scope?: unknown; scp?: unknown }, required: readonly string[]): void {
  const fromString = payload.scope === undefined ? undefined
    : scopes.safeParse(typeof payload.scope === "string" ? payload.scope.split(" ") : undefined);
  const fromArray = payload.scp === undefined ? undefined : scopes.safeParse(payload.scp);
  if ((!fromString && !fromArray) || (fromString && !fromString.success) || (fromArray && !fromArray.success)) {
    throw new Rejection("scope", "insufficient_scope");
  }
  const stringScopes = fromString?.success ? fromString.data : undefined;
  const arrayScopes = fromArray?.success ? fromArray.data : undefined;
  if (stringScopes && arrayScopes && (stringScopes.some((s) => !arrayScopes.includes(s))
    || arrayScopes.some((s) => !stringScopes.includes(s)))) {
    throw new Rejection("scope", "insufficient_scope");
  }
  const granted = stringScopes ?? arrayScopes ?? [];
  if (!required.every((scope) => granted.includes(scope))) throw new Rejection("scope", "insufficient_scope");
}

function audienceIncludes(aud: unknown, resourceUrl: string): boolean {
  if (typeof aud === "string") return aud === resourceUrl;
  return Array.isArray(aud) && aud.length > 0 && aud.length <= 16
    && aud.every((value) => typeof value === "string" && value.length > 0) && aud.includes(resourceUrl);
}

function classify(error: unknown): RejectReason | undefined {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "typ": return "token_type";
      case "iss": return "issuer";
      case "aud": return "audience";
      case "nbf": return "not_yet_valid";
      default: return "claims";
    }
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return "signature";
  if (error instanceof errors.JWKSNoMatchingKey) return "unknown_key";
  if (error instanceof errors.JOSEAlgNotAllowed) return "algorithm";
  if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid
    || error instanceof errors.JOSENotSupported) return "malformed";
  return undefined;
}

const KNOWN_TYPS = new Set(["at+jwt", "application/at+jwt", "JWT", "jwt"]);
const KNOWN_ALGS = new Set(["RS256", "RS384", "RS512", "ES256", "EdDSA", "HS256", "none"]);
const ORIGIN_LIKE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/?$/;

/**
 * Non-secret token shape for one rejection log line. Decodes WITHOUT verification, so it is used only
 * for diagnostics and never for an auth decision. Only enumerated header values, claim presence, and
 * an origin-shaped issuer are reported; never the token, subject, client, session or scope values.
 */
function tokenShape(token: string, issuer: string, resourceUrl: string): Record<string, unknown> {
  if (token.startsWith("oat_")) return { kind: "opaque" };
  if (!JWT_FORMAT.test(token)) return { kind: "malformed" };
  try {
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    const iss = payload.iss;
    return {
      kind: "jwt",
      typ: header.typ === undefined ? "absent" : KNOWN_TYPS.has(header.typ) ? header.typ : "other",
      alg: header.alg === undefined ? "absent" : KNOWN_ALGS.has(header.alg) ? header.alg : "other",
      cat: header.cat === undefined ? "absent" : NON_OAUTH_CATEGORIES.get(String(header.cat)) ?? "other",
      iss: iss === undefined ? "absent" : iss === issuer || ORIGIN_LIKE.test(iss) ? iss : "other",
      aud: payload.aud === undefined ? "absent" : Array.isArray(payload.aud) ? "array" : typeof payload.aud,
      audIncludesResource: audienceIncludes(payload.aud, resourceUrl),
      sub: typeof payload.sub !== "string" ? "absent" : payload.sub.startsWith("user_") ? "user"
        : payload.sub.startsWith("mch_") ? "machine" : "other",
      clientId: "client_id" in payload, sid: "sid" in payload, azp: "azp" in payload,
      scope: typeof payload.scope, scp: Array.isArray(payload.scp),
    };
  } catch (error: unknown) {
    if (error instanceof errors.JOSEError || error instanceof TypeError) return { kind: "malformed" };
    return { kind: "undecodable", error: error instanceof Error ? error.name : "UnknownError" };
  }
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
  const requiredScopes = options.requiredScopes ?? DEFAULT_MCP_REQUIRED_SCOPES;
  if (requiredScopes.length === 0 || requiredScopes.some((scope) => !scopeToken.safeParse(scope).success)) {
    throw new Error("Invalid MCP authentication configuration");
  }
  let diagnosticsUntil = 0;
  let diagnostics = 0;
  function rejected(token: string, reason: RejectReason, code: McpAuthError["code"]): McpAuthError {
    // Bounded so unauthenticated floods cannot flood logs; edge metrics still count every 401/403.
    const now = Date.now();
    if (diagnosticsUntil <= now) { diagnosticsUntil = now + 60_000; diagnostics = 0; }
    if (++diagnostics <= DIAGNOSTICS_PER_MINUTE) {
      console.warn(`[mcp] auth rejected: ${reason} ${JSON.stringify(tokenShape(token, options.issuer, options.resourceUrl))}`);
    }
    return new McpAuthError(code);
  }
  return async (token) => {
    if (!token || token.length > 16_384) throw rejected("", "malformed", "invalid_token");
    // Clerk OAuth tokens are JWTs unless the instance opts into opaque tokens. Opaque tokens would need
    // a per-request introspection call with the Clerk secret key; they are rejected explicitly instead.
    if (token.startsWith("oat_")) throw rejected(token, "opaque_token", "invalid_token");
    try {
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms: ["RS256"], issuer: options.issuer, audience: options.resourceUrl,
        // Signed RFC 9068 type: what separates Clerk OAuth access tokens from session and JWT-template
        // tokens signed by the same instance keys (the same check @clerk/backend applies).
        typ: OAUTH_ACCESS_TOKEN_TYP, clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["exp", "iat", "sub", "client_id"],
      });
      const now = Math.floor(Date.now() / 1000);
      if (protectedHeader.cat !== undefined && NON_OAUTH_CATEGORIES.has(String(protectedHeader.cat))) {
        throw new Rejection("token_category");
      }
      // Skew applies to nbf/iat only. An expired token must get a 401 the client can renew on,
      // not a downstream tool error after admission.
      if (typeof payload.exp === "number" && payload.exp <= now) throw new Rejection("expired");
      if (!audienceIncludes(payload.aud, options.resourceUrl)) throw new Rejection("audience");
      // `sid` is allowed: Clerk OAuth access tokens record the authorizing session. The signed `typ`
      // plus `client_id` and the resource audience are what make this an OAuth token, not a session.
      if (typeof payload.sub !== "string" || !/^user_[A-Za-z0-9]{1,128}$/.test(payload.sub)
        || typeof payload.client_id !== "string" || !/^[\x21-\x7E]{1,256}$/.test(payload.client_id)
        || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
        || payload.iat! > now + CLOCK_TOLERANCE_SECONDS || payload.exp! <= payload.iat!) {
        throw new Rejection("claims");
      }
      requireScope({ scope: payload.scope, scp: payload.scp }, requiredScopes);
      if (options.pilotCohortPolicy && !isPilotCohortMember(options.pilotCohortPolicy, payload.sub)) {
        throw new Rejection("scope", "insufficient_scope");
      }
      return { userId: payload.sub, clientId: payload.client_id, expiresAt: payload.exp! };
    } catch (error) {
      if (error instanceof Rejection) throw rejected(token, error.reason, error.code);
      const reason = classify(error);
      if (reason) throw rejected(token, reason, "invalid_token");
      // Provider outages/malformed keys are not evidence that the caller's credentials are bad.
      // The route logs a coarse service failure and returns 503, without token/error details.
      throw new Error("MCP authentication service unavailable", { cause: error });
    }
  };
}
