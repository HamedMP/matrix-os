import { importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";

const HANDOFF_AUDIENCE = "matrix-browser-handoff";
const HANDOFF_ISSUER = "matrix-os-platform";
const MAX_USED_NONCES = 10_000;

export interface BrowserHandoffClaims extends JWTPayload {
  ownerId: string;
  deviceId: string;
  target: string;
  nonce: string;
}

/**
 * Bounded replay cache for one-use platform handoff tokens.
 *
 * The default instance is process-local by design: token TTL is 60 seconds and
 * production callers should keep the store at gateway singleton scope. A
 * restart inside that short TTL can allow a captured token to be retried, so
 * routes must pair this with TLS, short expiry, owner binding, and generic
 * rejection handling.
 */
export class BrowserHandoffReplayStore {
  private readonly used = new Map<string, number>();

  seen(nonce: string, now = Date.now()): boolean {
    if (this.used.has(nonce)) return true;
    this.used.set(nonce, now);
    while (this.used.size > MAX_USED_NONCES) {
      const first = this.used.keys().next().value as string | undefined;
      if (!first) break;
      this.used.delete(first);
    }
    return false;
  }
}

export async function signBrowserHandoffToken(opts: {
  privateKey: CryptoKey | Uint8Array;
  keyId: string;
  ownerId: string;
  deviceId: string;
  target: string;
  nonce: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  return new SignJWT({
    ownerId: opts.ownerId,
    deviceId: opts.deviceId,
    target: opts.target,
    nonce: opts.nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.keyId, typ: "JWT" })
    .setIssuer(HANDOFF_ISSUER)
    .setAudience(HANDOFF_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + (opts.ttlSeconds ?? 60))
    .sign(opts.privateKey);
}

export async function verifyBrowserHandoffToken(opts: {
  token: string;
  publicKey: CryptoKey | string | Uint8Array;
  expectedOwnerId: string;
  replayStore?: BrowserHandoffReplayStore;
  now?: Date;
}): Promise<BrowserHandoffClaims> {
  const key = typeof opts.publicKey === "string"
    ? await importSPKI(opts.publicKey.replaceAll("\\n", "\n"), "RS256")
    : opts.publicKey;
  const { payload } = await jwtVerify(opts.token, key, {
    issuer: HANDOFF_ISSUER,
    audience: HANDOFF_AUDIENCE,
    currentDate: opts.now,
  });
  if (payload.ownerId !== opts.expectedOwnerId) {
    throw new Error("invalid_handoff");
  }
  if (
    typeof payload.deviceId !== "string" ||
    typeof payload.target !== "string" ||
    typeof payload.nonce !== "string"
  ) {
    throw new Error("invalid_handoff");
  }
  if (opts.replayStore?.seen(payload.nonce)) {
    throw new Error("invalid_handoff_replay");
  }
  return payload as BrowserHandoffClaims;
}
