/**
 * Ed25519 and digest helpers for direct sessions on the home (S05 / T027).
 * Mirrors the platform's ticket encoding: canonical JSON, raw 32-byte
 * base64url public keys, base64url SHA-256 thumbprints.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_BYTES = 32;
const TICKET_DOMAIN = "matrix-collaboration-ticket-v2";
const POSSESSION_DOMAIN = "matrix-collaboration-possession-v2";
const REQUEST_DOMAIN = "matrix-collaboration-request-v2";

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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function proofKeyThumbprint(publicKeyRaw: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyRaw, "base64url")).digest("base64url");
}

export function ed25519PublicKeyFromRaw(rawBase64Url: string): KeyObject | null {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.byteLength !== RAW_KEY_BYTES) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
  } catch (error: unknown) {
    console.warn("[collaboration-direct-crypto] public key rejected", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export function verifyEd25519(publicKeyRaw: string, payload: string, signature: string): boolean {
  const key = ed25519PublicKeyFromRaw(publicKeyRaw);
  const bytes = Buffer.from(signature, "base64url");
  if (!key || bytes.byteLength !== 64) return false;
  try {
    return verify(null, Buffer.from(payload, "utf8"), key, bytes);
  } catch (error: unknown) {
    console.warn("[collaboration-direct-crypto] verification failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

export function ticketSigningPayload(ticket: unknown): string {
  return `${TICKET_DOMAIN}\n${canonicalJson(ticket)}`;
}

export function possessionPayload(input: { ticketNonce: string; purpose: string; sessionId?: string }): string {
  return `${POSSESSION_DOMAIN}\n${input.ticketNonce}\n${input.purpose}\n${input.sessionId ?? ""}`;
}

export function requestSigningPayload(signature: unknown): string {
  return `${REQUEST_DOMAIN}\n${canonicalJson(signature)}`;
}

/** Home runtime identity key: generated once, seed kept in the owner database. */
export function generateRuntimeKeyPair(): { seed: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    seed: Buffer.from(pkcs8.subarray(pkcs8.byteLength - RAW_KEY_BYTES)).toString("base64url"),
    publicKey: Buffer.from(spki.subarray(spki.byteLength - RAW_KEY_BYTES)).toString("base64url"),
  };
}

export function signWithSeed(seedBase64Url: string, payload: string): string {
  const seed = Buffer.from(seedBase64Url, "base64url");
  if (seed.byteLength !== RAW_KEY_BYTES) throw new Error("Runtime key seed must be 32 bytes");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}
