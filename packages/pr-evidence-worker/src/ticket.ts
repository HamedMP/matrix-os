import { z } from "zod/v4";
import { base64Url, fromBase64Url, utf8 } from "./encoding.js";
import { isMediaType, MAX_FILE_BYTES, type MediaType } from "./media.js";

export const TICKET_TTL_MS = 5 * 60 * 1000;
export const MIN_TICKET_SECRET_LENGTH = 32;

const TicketPayloadSchema = z.object({
  v: z.literal(1),
  k: z.string().min(1).max(128),
  t: z.string().refine(isMediaType),
  s: z.number().int().positive().max(MAX_FILE_BYTES),
  e: z.number().int().positive(),
});

export interface UploadTicket {
  key: string;
  contentType: MediaType;
  size: number;
  expiresAt: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signUploadTicket(secret: string, ticket: UploadTicket): Promise<string> {
  const payload = base64Url(utf8(JSON.stringify({ v: 1, k: ticket.key, t: ticket.contentType, s: ticket.size, e: ticket.expiresAt })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload)));
  return `${payload}.${base64Url(signature)}`;
}

/** Verifies signature (constant time via WebCrypto) and expiry. Returns null for any invalid ticket. */
export async function verifyUploadTicket(secret: string, token: string, now = Date.now()): Promise<UploadTicket | null> {
  if (token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signaturePart] = parts as [string, string];
  const signature = fromBase64Url(signaturePart);
  if (!signature || signature.length !== 32) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(payload));
  if (!valid) return null;
  const payloadBytes = fromBase64Url(payload);
  if (!payloadBytes) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = TicketPayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;
  if (parsed.data.e <= now) return null;
  return { key: parsed.data.k, contentType: parsed.data.t as MediaType, size: parsed.data.s, expiresAt: parsed.data.e };
}
