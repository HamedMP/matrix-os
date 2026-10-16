import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`SSRF blocked: ${reason} (${url})`);
    this.name = "SsrfBlockedError";
    this.url = url;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b, c, d] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    // 192.0.0.9 and .10 are globally reachable PCP/TURN anycast exceptions.
    || (a === 192 && b === 0 && (c === 2 || (c === 0 && d !== 9 && d !== 10)))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

// Called only after node:net has validated the address. Compare numeric words
// so expanded, compressed, mixed and URL-normalized spellings share one policy.
function ipv6Words(ip: string): number[] {
  let address = ip.split("%", 1)[0];
  if (address.includes(".")) {
    const start = address.lastIndexOf(":") + 1;
    const octets = address.slice(start).split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, start)}${high}:${low}`;
  }
  const parseWords = (part: string) => part
    ? part.split(":").map((word) => parseInt(word, 16))
    : [];
  const [left, right] = address.split("::");
  const head = parseWords(left);
  if (right === undefined) return head;
  const tail = parseWords(right);
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function isPrivateIpv6(ip: string): boolean {
  const words = ipv6Words(ip);
  // IPv4-mapped (::ffff:0:0/96) and legacy compatible (::/96) addresses
  // must apply IPv4 policy even when their last 32 bits are hexadecimal.
  if (words.slice(0, 5).every((word) => word === 0)
    && (words[5] === 0xffff || words[5] === 0)) {
    const ipv4 = [
      words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff,
    ].join(".");
    return isPrivateIpv4(ipv4);
  }
  return (words[0] & 0xfe00) === 0xfc00 // unique-local fc00::/7
    || (words[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (words[0] & 0xffc0) === 0xfec0 // deprecated site-local fec0::/10
    || (words[0] & 0xff00) === 0xff00 // multicast ff00::/8
    || (words[0] === 0x2001 && words[1] === 0xdb8); // documentation
}

export function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  return false;
}

const BLOCKED_HOSTNAMES = [
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "metadata.internal",
];

export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(lower)) return true;
  if (isPrivateIp(hostname)) return true;
  return false;
}

export interface SsrfGuardOptions {
  allowedHostnames?: string[];
}

function matchesAllowlist(
  hostname: string,
  allowed: string[],
): boolean {
  const lower = hostname.toLowerCase();
  for (const pattern of allowed) {
    const p = pattern.toLowerCase();
    if (p === lower) return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      if (lower.endsWith(suffix) || lower === p.slice(2)) return true;
    }
  }
  return false;
}

export async function validateUrl(
  url: string,
  opts?: SsrfGuardOptions,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err: unknown) {
    console.warn("[ssrf] Invalid URL:", err instanceof Error ? err.message : String(err));
    throw new SsrfBlockedError(url, "invalid URL");
  }

  const hostname = parsed.hostname;

  if (opts?.allowedHostnames && matchesAllowlist(hostname, opts.allowedHostnames)) {
    return;
  }

  if (isBlockedHostname(hostname)) {
    throw new SsrfBlockedError(url, `blocked hostname: ${hostname}`);
  }

  if (isPrivateIp(hostname)) {
    throw new SsrfBlockedError(url, `private IP: ${hostname}`);
  }

  try {
    const ips = await resolve4(hostname).catch((err: unknown) => {
      console.warn("[ssrf] IPv4 DNS lookup failed:", err instanceof Error ? err.message : String(err));
      return [] as string[];
    });
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new SsrfBlockedError(url, `DNS resolved to private IP: ${ip}`);
      }
    }

    const ipv6s = await resolve6(hostname).catch((err: unknown) => {
      console.warn("[ssrf] IPv6 DNS lookup failed:", err instanceof Error ? err.message : String(err));
      return [] as string[];
    });
    for (const ip of ipv6s) {
      if (isPrivateIp(ip)) {
        throw new SsrfBlockedError(url, `DNS resolved to private IPv6: ${ip}`);
      }
    }
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err;
    // DNS resolution failure for non-IP hostnames is OK (e.g. "example.com" in test env)
  }
}
