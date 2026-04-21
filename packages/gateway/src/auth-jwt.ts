import { importSPKI, jwtVerify, type JWTPayload } from "jose";

export const SYNC_JWT_ISSUER = "matrix-os-platform";
export const SYNC_JWT_AUDIENCE = "matrix-os-sync";

export interface SyncJwtClaims extends JWTPayload {
  sub: string;
  handle: string;
  gateway_url: string;
  aud?: string | string[];
  iat: number;
  exp: number;
  iss: string;
}

export interface JwtKeyConfig {
  /** HS256 shared secret (>= 32 chars). Either this or publicKey must be set. */
  secret?: string;
  /** RS256 public key. */
  publicKey?: CryptoKey;
}

export interface ValidateOpts extends JwtKeyConfig {
  expectedHandle?: string;
  /** Seconds of clock skew to tolerate. Default 30s. */
  clockTolerance?: number;
  /** Override current time for testing (epoch seconds). */
  now?: number;
}

/**
 * Looks like a JWT (three base64url segments) -- bareword secrets like
 * the legacy MATRIX_AUTH_TOKEN don't match. Used to route bearer tokens
 * to the JWT validator vs. the legacy timing-safe compare.
 */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const isBase64Url = /^[A-Za-z0-9_-]+$/;
  return parts.every((p) => p.length > 0 && isBase64Url.test(p));
}

function secretToKey(secret: string): Uint8Array {
  if (secret.length < 32) {
    throw new Error(
      "PLATFORM_JWT_SECRET must be at least 32 characters (HS256 minimum key size)",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function validateSyncJwt(
  token: string,
  opts: ValidateOpts,
): Promise<SyncJwtClaims> {
  if (!opts.secret && !opts.publicKey) {
    throw new Error("validateSyncJwt requires either secret or publicKey");
  }
  const key = opts.secret ? secretToKey(opts.secret) : opts.publicKey!;

  const { payload } = await jwtVerify(token, key, {
    issuer: SYNC_JWT_ISSUER,
    audience: SYNC_JWT_AUDIENCE,
    algorithms: opts.publicKey ? ["RS256"] : ["HS256"],
    clockTolerance: opts.clockTolerance ?? 30,
    currentDate: opts.now !== undefined ? new Date(opts.now * 1000) : undefined,
  });

  if (
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.handle !== "string" ||
    payload.handle.length === 0 ||
    typeof payload.gateway_url !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Invalid sync JWT: missing required claims");
  }

  if (opts.expectedHandle && payload.handle !== opts.expectedHandle) {
    throw new Error(
      `Sync JWT handle "${payload.handle}" does not match this gateway's handle "${opts.expectedHandle}"`,
    );
  }

  return payload as SyncJwtClaims;
}

const publicKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Reads the JWT key configuration from environment variables. Prefers
 * PLATFORM_JWT_PUBLIC_KEY (RS256, prod) over PLATFORM_JWT_SECRET (HS256, dev).
 * Returns null if neither is set -- the gateway then falls back to the
 * legacy MATRIX_AUTH_TOKEN bearer secret only.
 */
export async function readJwtKeyConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<JwtKeyConfig | null> {
  const pub = env.PLATFORM_JWT_PUBLIC_KEY;
  if (pub) {
    let cached = publicKeyCache.get(pub);
    if (!cached) {
      publicKeyCache.clear();
      cached = importSPKI(pub, "RS256");
      publicKeyCache.set(pub, cached);
    }
    return { publicKey: await cached };
  }
  const secret = env.PLATFORM_JWT_SECRET;
  if (secret && secret.length >= 32) {
    return { secret };
  }
  return null;
}
