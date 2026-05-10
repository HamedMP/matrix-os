import { lookup } from "node:dns/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isIP } from "node:net";

const SAFE_PROFILE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const MAX_ARTIFACT_PATH_LENGTH = 512;
const DNS_LOOKUP_TIMEOUT_MS = 3_000;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
];

export class BrowserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserInputError";
  }
}

export function isBrowserInputError(error: unknown): error is BrowserInputError {
  return error instanceof BrowserInputError;
}

export function normalizeBrowserProfileName(
  profile: string | undefined,
  defaultProfile = "default",
): string {
  const candidate = profile ?? defaultProfile;
  if (!SAFE_PROFILE_NAME.test(candidate)) {
    throw new BrowserInputError("Invalid browser profile name");
  }
  return candidate;
}

export function resolveBrowserProfilePath(
  homePath: string,
  profile: string | undefined,
  defaultProfile = "default",
): string {
  const profileName = normalizeBrowserProfileName(profile, defaultProfile);
  return join(resolve(homePath), "data", "browser-profiles", profileName);
}

function normalizeArtifactPath(path: string): string {
  if (
    path.length === 0 ||
    path.length > MAX_ARTIFACT_PATH_LENGTH ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path)
  ) {
    throw new BrowserInputError("Invalid browser artifact path");
  }

  const segments = path
    .replace(/\/+/g, "/")
    .split("/")
    .filter((segment) => segment !== "." && segment !== "");

  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new BrowserInputError("Invalid browser artifact path");
  }

  return segments.join("/");
}

export function resolveBrowserArtifactPath(
  homePath: string,
  defaultFilename: string,
  requestedPath?: string,
): string {
  const base = resolve(homePath, "data", "screenshots");
  const relativePath = normalizeArtifactPath(requestedPath ?? defaultFilename);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BrowserInputError("Invalid browser artifact path");
  }

  return target;
}

export type ResolveHostname = (hostname: string) => Promise<string[]>;

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserInputError("Browser navigation URL could not be verified")), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [a, b] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    (a >= 224 && a <= 255)
  );
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  const mappedIpv4 = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4?.[1]) {
    return isBlockedIpv4(mappedIpv4[1]);
  }
  if (lower.startsWith("::ffff:")) {
    return true;
  }

  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fec") ||
    lower.startsWith("fed") ||
    lower.startsWith("fee") ||
    lower.startsWith("fef") ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8")
  );
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

export async function assertSafeBrowserUrl(
  rawUrl: string,
  opts: {
    resolveHostname?: ResolveHostname;
    dnsTimeoutMs?: number;
  } = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new BrowserInputError("Browser navigation URL is invalid");
    }
    throw new BrowserInputError("Browser navigation URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserInputError("Browser navigation URL must use http or https");
  }

  const hostname = parsed.hostname.replace(/^\[(.*)]$/, "$1");

  if (parsed.username || parsed.password || isBlockedHostname(hostname)) {
    throw new BrowserInputError("Browser navigation URL is not allowed");
  }

  const literalIpVersion = isIP(hostname);
  if (literalIpVersion !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new BrowserInputError("Browser navigation URL is not allowed");
    }
    return parsed.toString();
  }

  const resolver = opts.resolveHostname ?? defaultResolveHostname;
  let addresses: string[];
  try {
    addresses = await withTimeout(resolver(hostname), opts.dnsTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS);
  } catch (error) {
    if (isBrowserInputError(error)) throw error;
    throw new BrowserInputError("Browser navigation URL could not be verified");
  }

  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw new BrowserInputError("Browser navigation URL is not allowed");
  }

  return parsed.toString();
}
