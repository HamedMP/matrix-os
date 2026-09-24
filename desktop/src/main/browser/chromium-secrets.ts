import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";

export interface BrowserLogin {
  origin: string;
  username: string;
  password: string;
}

export interface BrowserCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const MAX_SECRET_BYTES = 64 * 1024;

/** Chromium's macOS v10 OSCrypt format. Unknown versions fail closed. */
export function decryptChromiumSecret(blob: Buffer, keychainPassword: string): string | null {
  return decryptChromiumBytes(blob, keychainPassword)?.toString("utf8") ?? null;
}

export function decryptChromiumBytes(blob: Buffer, keychainPassword: string): Buffer | null {
  if (blob.length < 19 || blob.length > MAX_SECRET_BYTES || blob.subarray(0, 3).toString() !== "v10") return null;
  try {
    const key = pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
}

export function decodeChromiumCookieValue(value: Buffer, hostKey: string, databaseVersion: number): string | null {
  if (databaseVersion < 24) return value.toString("utf8");
  if (value.length < 32) return null;
  const digest = createHash("sha256").update(hostKey).digest();
  if (!timingSafeEqual(value.subarray(0, 32), digest)) return null;
  return value.subarray(32).toString("utf8");
}

function webOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeChromiumLogin(row: Record<string, unknown>, password: string): BrowserLogin | null {
  const origin = webOrigin(row.origin_url);
  if (!origin || typeof row.username_value !== "string" || !row.username_value.trim()
    || row.username_value.length > 512 || !password || password.length > MAX_SECRET_BYTES
    || row.blacklisted_by_user === 1) return null;
  return { origin, username: row.username_value, password };
}

export function normalizeChromiumCookie(
  row: Record<string, unknown>,
  value: string,
  nowSeconds: number = Date.now() / 1000,
): BrowserCookie | null {
  const rawHost = row.host_key;
  if (typeof rawHost !== "string" || rawHost.length > 253 || !rawHost ||
    typeof row.name !== "string" || !row.name || row.name.length > 256 ||
    typeof value !== "string" || value.length > MAX_SECRET_BYTES ||
    (typeof row.top_frame_site_key === "string" && row.top_frame_site_key.length > 0)) return null;
  const host = rawHost.startsWith(".") ? rawHost.slice(1) : rawHost;
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  const path = typeof row.path === "string" && row.path.startsWith("/") && row.path.length <= 1_024 ? row.path : "/";
  const secure = row.is_secure === 1;
  const isPersistent = row.is_persistent === 1;
  const expiresUtc = Number(row.expires_utc);
  const expirationDate = isPersistent && Number.isFinite(expiresUtc)
    ? expiresUtc / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS : undefined;
  if (isPersistent && (expirationDate === undefined || expirationDate <= nowSeconds || expirationDate > nowSeconds + 20 * 365 * 86_400)) return null;
  const sameSite = row.samesite === 0 ? "no_restriction"
    : row.samesite === 1 ? "lax" : row.samesite === 2 ? "strict" : undefined;
  if (sameSite === "no_restriction" && !secure) return null;
  return {
    url: `${secure ? "https" : "http"}://${host}${path}`,
    ...(rawHost.startsWith(".") ? { domain: rawHost } : {}),
    name: row.name, value, path, secure, httpOnly: row.is_httponly === 1,
    ...(sameSite ? { sameSite } : {}),
    ...(expirationDate !== undefined ? { expirationDate } : {}),
  };
}
