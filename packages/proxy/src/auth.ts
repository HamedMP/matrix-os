import { createHmac, timingSafeEqual } from "node:crypto";

const PROXY_API_KEY_PREFIX = "sk-proxy-";

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const maxLen = Math.max(aBuf.length, bBuf.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  aBuf.copy(paddedA);
  bBuf.copy(paddedB);
  const equal = timingSafeEqual(paddedA, paddedB);
  return aBuf.length === bBuf.length && equal;
}

function signatureForHandle(handle: string, secret: string): string {
  return createHmac("sha256", secret).update(`proxy:${handle}`).digest("base64url");
}

export function buildProxyApiKey(handle: string, secret: string): string {
  return `${PROXY_API_KEY_PREFIX}${handle}.${signatureForHandle(handle, secret)}`;
}

export function parseProxyApiKey(
  key: string,
  secret: string | undefined,
): { handle: string } | null {
  if (!secret || !key.startsWith(PROXY_API_KEY_PREFIX)) return null;
  const rest = key.slice(PROXY_API_KEY_PREFIX.length);
  const separator = rest.lastIndexOf(".");
  if (separator <= 0 || separator === rest.length - 1) return null;
  const handle = rest.slice(0, separator);
  const signature = rest.slice(separator + 1);
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(handle)) return null;
  const expected = signatureForHandle(handle, secret);
  return timingSafeCompare(signature, expected) ? { handle } : null;
}

export function isAuthorizedProxyAdminRequest(
  headers: Headers,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const auth = headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return timingSafeCompare(auth.slice("Bearer ".length), token);
}
