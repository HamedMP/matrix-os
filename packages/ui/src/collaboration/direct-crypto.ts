/**
 * Browser-side primitives for the direct collaboration protocol (S06 / T031).
 * Web Crypto only: an Ed25519 proof key that is generated per scope session,
 * never extractable and never persisted; canonical JSON and SHA-256 that
 * match the home's `direct-crypto.ts` byte for byte.
 */

const POSSESSION_DOMAIN = "matrix-collaboration-possession-v2";
const REQUEST_DOMAIN = "matrix-collaboration-request-v2";
const RAW_KEY_BYTES = 32;

export interface ProofKeyPair {
  readonly privateKey: CryptoKey;
  /** Raw 32-byte public key, base64url (43 characters). */
  readonly publicKeyRaw: string;
}

export function subtleCrypto(explicit?: SubtleCrypto): SubtleCrypto {
  const subtle = explicit ?? globalThis.crypto?.subtle;
  if (!subtle) throw new Error("CollaborationUnavailable");
  return subtle;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeBase64UrlJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

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

export async function sha256Hex(bytes: Uint8Array, subtle?: SubtleCrypto): Promise<string> {
  const digest = new Uint8Array(await subtleCrypto(subtle).digest("SHA-256", bytes as BufferSource));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function randomHex(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  let hex = "";
  for (const byte of buffer) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/** A fresh non-extractable Ed25519 proof key. The private key never leaves the CryptoKey object. */
export async function generateProofKey(subtle?: SubtleCrypto): Promise<ProofKeyPair> {
  const api = subtleCrypto(subtle);
  const pair = await api.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await api.exportKey("raw", pair.publicKey));
  if (raw.byteLength !== RAW_KEY_BYTES) throw new Error("CollaborationUnavailable");
  return { privateKey: pair.privateKey, publicKeyRaw: toBase64Url(raw) };
}

export async function signPayload(key: ProofKeyPair, payload: string, subtle?: SubtleCrypto): Promise<string> {
  const signature = await subtleCrypto(subtle).sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(payload));
  return toBase64Url(signature);
}

export function possessionPayload(input: { ticketNonce: string; purpose: string; sessionId?: string }): string {
  return `${POSSESSION_DOMAIN}\n${input.ticketNonce}\n${input.purpose}\n${input.sessionId ?? ""}`;
}

export function requestSigningPayload(signature: unknown): string {
  return `${REQUEST_DOMAIN}\n${canonicalJson(signature)}`;
}
