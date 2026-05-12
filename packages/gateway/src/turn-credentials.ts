import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export interface BrowserTurnCredential {
  urls: string[];
  username: string;
  credential: string;
  expiresAt: string;
  iceTransportPolicy: "relay";
}

export function mintBrowserTurnCredential(opts: {
  ownerId: string;
  sessionId: string;
  urls: string[];
  secret: string;
  now?: number;
  ttlSeconds?: number;
}): BrowserTurnCredential {
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const expires = nowSeconds + (opts.ttlSeconds ?? 300);
  const username = `${expires}:${opts.ownerId}:${opts.sessionId}:${randomUUID()}`;
  const credential = createHmac("sha1", opts.secret).update(username).digest("base64");
  return {
    urls: opts.urls,
    username,
    credential,
    expiresAt: new Date(expires * 1000).toISOString(),
    iceTransportPolicy: "relay",
  };
}

export function isBrowserRelayCandidate(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  if (!(lower.includes(" typ relay ") || lower.endsWith(" typ relay"))) {
    return false;
  }
  if (/\blocalhost\b/i.test(candidate)) {
    return false;
  }
  const parts = candidate.trim().split(/\s+/);
  const address = parts[4];
  return Boolean(address && isPublicIceAddress(address));
}

export function assertBrowserRelayCandidate(candidate: string): void {
  if (!isBrowserRelayCandidate(candidate)) {
    throw new Error("media_policy");
  }
}

function isPublicIceAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPublicIpv4(mapped[1] ?? "");
  const ipVersion = isIP(address);
  if (ipVersion === 4) return isPublicIpv4(address);
  if (ipVersion === 6) {
    const lower = address.toLowerCase();
    return !(
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:") ||
      lower.startsWith("ff")
    );
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = -1, b = -1] = address.split(".").map((part) => Number.parseInt(part, 10));
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}
