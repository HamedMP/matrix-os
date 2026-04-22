import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";

export const AppSessionPayload = z.object({
  v: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  principal: z.literal("gateway-owner"),
  scope: z.literal("personal"),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export type AppSessionPayloadType = z.infer<typeof AppSessionPayload>;

const HKDF_HASH = "sha256";
const HKDF_SALT = Buffer.alloc(32, 0);
const HKDF_KEY_LENGTH = 32;
const MIN_MASTER_SECRET_BYTES = 16;

// The HKDF info string is public (derived from the slug). If masterSecret is
// empty or too short, any caller can reproduce the derived key and forge
// session cookies for any slug. Callers MUST supply a high-entropy secret.
export function deriveAppSessionKey(masterSecret: string, slug: string): Buffer {
  if (masterSecret.length < MIN_MASTER_SECRET_BYTES) {
    throw new Error(
      `deriveAppSessionKey: masterSecret must be at least ${MIN_MASTER_SECRET_BYTES} bytes. Empty or short secrets produce a predictable HKDF key that an attacker can reproduce from the public info string.`,
    );
  }
  const info = `matrix-os/app-session/v1/${slug}`;
  return Buffer.from(
    hkdfSync(HKDF_HASH, masterSecret, HKDF_SALT, info, HKDF_KEY_LENGTH),
  );
}

export function signAppSession(
  key: Buffer,
  payload: AppSessionPayloadType,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function verifyAppSession(
  key: Buffer,
  token: string,
  nowSec: number,
): AppSessionPayloadType | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;

  const payloadB64 = token.slice(0, dotIndex);
  const receivedSig = token.slice(dotIndex + 1);

  const expectedSig = createHmac("sha256", key).update(payloadB64).digest("base64url");

  // Constant-time compare: both must be the same length for timingSafeEqual
  const receivedBuf = Buffer.from(receivedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");

  if (receivedBuf.length !== expectedBuf.length) return null;

  if (!timingSafeEqual(receivedBuf, expectedBuf)) return null;

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }

  const parsed = AppSessionPayload.safeParse(rawPayload);
  if (!parsed.success) return null;

  if (parsed.data.exp <= nowSec) return null;

  return parsed.data;
}

export function buildSetCookie(
  slug: string,
  value: string,
  opts: { maxAge: number; secure: boolean },
): string {
  return [
    `matrix_app_session__${slug}=${value}`,
    `Path=/apps/${slug}/`,
    "HttpOnly",
    "SameSite=Strict",
    opts.secure ? "Secure" : null,
    `Max-Age=${opts.maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}
