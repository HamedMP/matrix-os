/**
 * crypto.randomUUID, also in insecure contexts. Self-hosted Matrix may be served
 * over tailnet-only HTTP (already WireGuard-encrypted), where browsers hide
 * randomUUID but keep getRandomValues; build the same RFC 4122 v4 id from it.
 */
export function randomUUID(): string {
  const source = globalThis.crypto as Crypto | undefined;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues !== "function") {
    throw new Error("Secure random values are unavailable");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
