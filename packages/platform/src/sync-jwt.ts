import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export const SYNC_JWT_ISSUER = 'matrix-os-platform';
export const SYNC_JWT_AUDIENCE = 'matrix-os-sync';
const DEFAULT_EXPIRES_IN_SEC = 24 * 60 * 60; // 24 hours

export interface SyncJwtClaims extends JWTPayload {
  sub: string; // clerkUserId
  handle: string;
  gateway_url: string;
  aud?: string | string[];
  iat: number;
  exp: number;
  iss: string;
}

export interface IssueOpts {
  secret: string;
  clerkUserId: string;
  handle: string;
  gatewayUrl: string;
  expiresInSec?: number;
  now?: number; // epoch seconds; defaults to current time
}

export interface IssuedJwt {
  token: string;
  expiresAt: number; // epoch ms
  claims: SyncJwtClaims;
}

export interface VerifyOpts {
  secret?: string; // HS256
  publicKey?: CryptoKey | Uint8Array; // RS256 (future use)
  expectedHandle?: string;
  clockTolerance?: number; // seconds
  now?: number; // epoch seconds; for testing
}

function secretToKey(secret: string): Uint8Array {
  if (secret.length < 32) {
    throw new Error(
      'PLATFORM_JWT_SECRET must be at least 32 characters (HS256 minimum key size)',
    );
  }
  return new TextEncoder().encode(secret);
}

export async function issueSyncJwt(opts: IssueOpts): Promise<IssuedJwt> {
  const key = secretToKey(opts.secret);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expiresInSec = opts.expiresInSec ?? DEFAULT_EXPIRES_IN_SEC;
  const exp = now + expiresInSec;

  const claims: SyncJwtClaims = {
    sub: opts.clerkUserId,
    handle: opts.handle,
    gateway_url: opts.gatewayUrl,
    aud: SYNC_JWT_AUDIENCE,
    iat: now,
    exp,
    iss: SYNC_JWT_ISSUER,
  };

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(SYNC_JWT_AUDIENCE)
    .sign(key);

  return { token, expiresAt: exp * 1000, claims };
}

export async function verifySyncJwt(
  token: string,
  opts: VerifyOpts,
): Promise<SyncJwtClaims> {
  if (!opts.secret && !opts.publicKey) {
    throw new Error('verifySyncJwt requires either secret or publicKey');
  }

  const key = opts.secret ? secretToKey(opts.secret) : opts.publicKey!;

  const { payload } = await jwtVerify(token, key, {
    issuer: SYNC_JWT_ISSUER,
    audience: SYNC_JWT_AUDIENCE,
    algorithms: opts.publicKey ? ['RS256'] : ['HS256'],
    clockTolerance: opts.clockTolerance ?? 30,
    currentDate: opts.now !== undefined ? new Date(opts.now * 1000) : undefined,
  });

  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof payload.handle !== 'string' ||
    payload.handle.length === 0 ||
    typeof payload.gateway_url !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('Invalid sync JWT claims');
  }

  if (opts.expectedHandle && payload.handle !== opts.expectedHandle) {
    throw new Error(
      `JWT handle "${payload.handle}" does not match expected "${opts.expectedHandle}"`,
    );
  }

  return payload as SyncJwtClaims;
}
