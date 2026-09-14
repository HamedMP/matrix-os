import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedCustomMcpUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type CustomMcpResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export class CustomMcpUrlError extends Error {
  constructor() {
    super("Custom MCP server URL is not allowed");
    this.name = "CustomMcpUrlError";
  }
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((result, octet) =>
    ((result << 8) | Number(octet)) >>> 0, 0);
}

function inIpv4Range(address: string, network: string, prefix: number): boolean {
  const ip = ipv4Number(address);
  const base = ipv4Number(network);
  if (ip === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isForbiddenCustomMcpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return BLOCKED_IPV4.some(([network, prefix]) =>
      inIpv4Range(address, network, prefix));
  }
  if (family !== 6) return true;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  if (normalized.startsWith("2001:2:")) return true;
  if (normalized.startsWith("2001:10:")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return mapped.includes(".") ? isForbiddenCustomMcpAddress(mapped) : true;
  }
  return false;
}

function forbiddenHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return value === "localhost"
    || value === "metadata"
    || value === "metadata.google.internal"
    || value.endsWith(".localhost")
    || value.endsWith(".local")
    || value.endsWith(".internal")
    || value.endsWith(".test")
    || value.endsWith(".invalid")
    || value === "example.com"
    || value.endsWith(".example.com")
    || value === "example.net"
    || value.endsWith(".example.net")
    || value === "example.org"
    || value.endsWith(".example.org");
}

const defaultResolver: CustomMcpResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records
    .filter((record): record is { address: string; family: 4 | 6 } =>
      record.family === 4 || record.family === 6);
};

export async function validateCustomMcpUrl(
  rawUrl: string,
  resolver: CustomMcpResolver = defaultResolver,
): Promise<ResolvedCustomMcpUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (parseError: unknown) {
    console.warn(
      "[custom-mcp] URL parse failed:",
      parseError instanceof Error ? parseError.name : typeof parseError,
    );
    throw new CustomMcpUrlError();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new CustomMcpUrlError();
  }
  if (forbiddenHostname(url.hostname)) throw new CustomMcpUrlError();

  const normalizedHostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(normalizedHostname);
  if (literalFamily !== 0) {
    if (isForbiddenCustomMcpAddress(normalizedHostname)) throw new CustomMcpUrlError();
    return {
      url,
      address: normalizedHostname,
      family: literalFamily as 4 | 6,
    };
  }

  let records: Array<{ address: string; family: 4 | 6 }>;
  try {
    records = await resolver(normalizedHostname);
  } catch (resolutionError: unknown) {
    console.warn(
      "[custom-mcp] DNS resolution failed:",
      resolutionError instanceof Error ? resolutionError.message : String(resolutionError),
    );
    throw new CustomMcpUrlError();
  }
  if (records.length === 0 || records.some((record) =>
    isForbiddenCustomMcpAddress(record.address))) {
    throw new CustomMcpUrlError();
  }
  const selected = records[0]!;
  return { url, address: selected.address, family: selected.family };
}
