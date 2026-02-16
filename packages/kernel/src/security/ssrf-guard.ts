import { resolve4, resolve6 } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`SSRF blocked: ${reason} (${url})`);
    this.name = "SsrfBlockedError";
    this.url = url;
  }
}

const PRIVATE_IPV4_RANGES = [
  { prefix: "127.", label: "loopback" },
  { prefix: "10.", label: "class A private" },
  { prefix: "192.168.", label: "class C private" },
  { prefix: "169.254.", label: "link-local" },
  { prefix: "0.", label: "unspecified" },
];

function isPrivateIpv4(ip: string): boolean {
  for (const { prefix } of PRIVATE_IPV4_RANGES) {
    if (ip.startsWith(prefix)) return true;
  }

  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fec0:")) return true;

  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    if (mapped.includes(".")) {
      return isPrivateIpv4(mapped);
    }
  }

  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
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
  } catch {
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
    const ips = await resolve4(hostname).catch(() => [] as string[]);
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new SsrfBlockedError(url, `DNS resolved to private IP: ${ip}`);
      }
    }

    const ipv6s = await resolve6(hostname).catch(() => [] as string[]);
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
