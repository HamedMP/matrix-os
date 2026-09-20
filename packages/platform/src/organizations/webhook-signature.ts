/**
 * Standard Webhooks (Svix) signature verification for Clerk organization
 * webhooks (S03 / T018). Verifies on the raw bounded body: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 secret behind `whsec_`,
 * timing-safe comparison, and a bounded timestamp tolerance so replays of an
 * old delivery are refused even with a valid signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CLERK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_SIGNATURES = 8;
const SVIX_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ClerkWebhookSignatureResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: "invalid_secret" | "missing_headers" | "timestamp_out_of_tolerance" | "signature_mismatch" };

export function verifyClerkWebhookSignature(input: {
  signingSecret: string;
  body: string;
  headers: Record<string, string | undefined>;
  now?: () => Date;
}): ClerkWebhookSignatureResult {
  const secret = decodeSigningSecret(input.signingSecret);
  if (!secret) return { ok: false, reason: "invalid_secret" };
  const id = input.headers["svix-id"];
  const timestampHeader = input.headers["svix-timestamp"];
  const signatureHeader = input.headers["svix-signature"];
  if (!id || !timestampHeader || !signatureHeader || !SVIX_ID_PATTERN.test(id) || !/^\d{1,16}$/.test(timestampHeader)) {
    return { ok: false, reason: "missing_headers" };
  }
  const timestamp = Number(timestampHeader);
  const nowSeconds = Math.floor((input.now ?? (() => new Date()))().getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > CLERK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }
  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.${input.body}`).digest();
  const candidates = signatureHeader.split(" ").filter(Boolean).slice(0, MAX_SIGNATURES);
  for (const candidate of candidates) {
    const [version, encoded] = candidate.split(",", 2);
    if (version !== "v1" || !encoded) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(encoded, "base64");
    } catch (error: unknown) {
      console.warn("[organizations] webhook signature decode failed", error instanceof Error ? error.name : "UnknownError");
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { ok: true, eventId: id };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

function decodeSigningSecret(signingSecret: string): Buffer | null {
  if (!signingSecret.startsWith("whsec_")) return null;
  const encoded = signingSecret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(encoded)) return null;
  const secret = Buffer.from(encoded, "base64");
  return secret.length >= 16 ? secret : null;
}
