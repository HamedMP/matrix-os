/**
 * Ed25519 helpers for connection tickets (S05 / T026).
 *
 * Tickets are signed over a canonical JSON encoding so the home can verify
 * them byte-for-byte whichever ingress delivered them. Public keys travel as
 * the raw 32-byte Ed25519 key in base64url; the client proof-key thumbprint
 * is the base64url SHA-256 of that raw key (43 characters, as the frozen
 * contract requires).
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_BYTES = 32;
const TICKET_DOMAIN = "matrix-collaboration-ticket-v2";
export const POSSESSION_DOMAIN = "matrix-collaboration-possession-v2";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function ed25519PrivateKeyFromSeed(seedBase64Url: string): KeyObject {
  const seed = Buffer.from(seedBase64Url, "base64url");
  if (seed.byteLength !== RAW_KEY_BYTES) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function ed25519PublicKeyRaw(key: KeyObject): string {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.byteLength - RAW_KEY_BYTES)).toString("base64url");
}

export function ed25519PublicKeyFromRaw(rawBase64Url: string): KeyObject | null {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.byteLength !== RAW_KEY_BYTES) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
  } catch (error: unknown) {
    console.warn("[collaboration-ticket-crypto] public key rejected", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export function signEd25519(privateKey: KeyObject, payload: string): string {
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
}

export function verifyEd25519(publicKeyRaw: string, payload: string, signature: string): boolean {
  const key = ed25519PublicKeyFromRaw(publicKeyRaw);
  const bytes = Buffer.from(signature, "base64url");
  if (!key || bytes.byteLength !== 64) return false;
  try {
    return verify(null, Buffer.from(payload, "utf8"), key, bytes);
  } catch (error: unknown) {
    console.warn("[collaboration-ticket-crypto] signature verification failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

export function proofKeyThumbprint(publicKeyRaw: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyRaw, "base64url")).digest("base64url");
}

export function ticketSigningPayload(ticket: unknown): string {
  return `${TICKET_DOMAIN}\n${canonicalJson(ticket)}`;
}

/** What a client signs with its proof key to prove possession for one ticket. */
export function possessionPayload(input: { ticketNonce: string; purpose: string; sessionId?: string }): string {
  return `${POSSESSION_DOMAIN}\n${input.ticketNonce}\n${input.purpose}\n${input.sessionId ?? ""}`;
}
