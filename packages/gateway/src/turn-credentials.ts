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
    const hextets = expandIpv6(lower);
    if (hextets) {
      if (isIpv4MappedOrCompatible(hextets)) {
        return isPublicIpv4(ipv4FromLastHextets(hextets));
      }
      if (hextets[0] === 0x2001 && hextets[1] === 0x0000) return false;
      if (hextets[0] === 0x2002) return isPublicIpv4(ipv4FromHextets(hextets[1] ?? 0, hextets[2] ?? 0));
    }
    const firstHextet = hextets?.[0] ?? firstIpv6Hextet(lower);
    return !(
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      (firstHextet !== null && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
      lower.startsWith("ff")
    );
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = -1, b = -1, c = -1] = address.split(".").map((part) => Number.parseInt(part, 10));
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function firstIpv6Hextet(address: string): number | null {
  const match = address.match(/^([0-9a-f]{1,4})(?=:|$)/);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 16);
}

function expandIpv6(address: string): number[] | null {
  const input = address.toLowerCase();
  const compression = input.indexOf("::");
  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const hextets: number[] = [];
    for (const segment of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      hextets.push(Number.parseInt(segment, 16));
    }
    return hextets;
  };
  if (compression >= 0) {
    const left = parsePart(input.slice(0, compression));
    const right = parsePart(input.slice(compression + 2));
    if (!left || !right || left.length + right.length > 8) return null;
    return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  }
  const hextets = parsePart(input);
  return hextets?.length === 8 ? hextets : null;
}

function isIpv4MappedOrCompatible(hextets: number[]): boolean {
  return hextets.slice(0, 5).every((part) => part === 0) &&
    (hextets[5] === 0 || hextets[5] === 0xffff) &&
    (hextets[6] !== 0 || hextets[7] !== 0);
}

function ipv4FromLastHextets(hextets: number[]): string {
  return ipv4FromHextets(hextets[6] ?? 0, hextets[7] ?? 0);
}

function ipv4FromHextets(high: number, low: number): string {
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".");
}
