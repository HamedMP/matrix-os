import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { isPrivateIp } from "./ssrf-guard.js";

export type PinnedAddress = { address: string; family: number };
export type PinnedResolver = (hostname: string) => Promise<PinnedAddress[]>;
export type AddressPolicy = (address: string) => boolean;
export type PinnedFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface PinnedFetchOptions {
  /** Returns every address for a hostname; all of them must pass the policy. */
  resolve?: PinnedResolver;
  /** True when the server may connect to the address. */
  isAllowedAddress?: AddressPolicy;
  /** Bounds the connect-time resolution and TCP/TLS handshake. */
  connectTimeoutMs?: number;
}

const MAX_RESOLVED_ADDRESSES = 32;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 4_000;

export class PinnedAddressBlockedError extends Error {
  readonly code = "ERR_PINNED_ADDRESS_BLOCKED";

  constructor() {
    super("Destination address is not allowed");
    this.name = "PinnedAddressBlockedError";
  }
}

export const isPublicAddress: AddressPolicy = (address) =>
  isIP(address.replace(/^\[(.*)\]$/, "$1")) !== 0 && !isPrivateIp(address);

const systemResolver: PinnedResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("DNS resolution timed out")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolves at connect time and hands the socket only addresses that passed the
 * policy in that same resolution, so validation and connection share one answer.
 */
export function createValidatedLookup(options: PinnedFetchOptions = {}): LookupFunction {
  const resolve = options.resolve ?? systemResolver;
  const isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return (hostname, lookupOptions, callback) => {
    void (async () => {
      const literal = hostname.replace(/^\[(.*)\]$/, "$1");
      const family = isIP(literal);
      const records = family !== 0
        ? [{ address: literal, family }]
        : await withTimeout(resolve(hostname), timeoutMs);
      if (
        records.length === 0
        || records.length > MAX_RESOLVED_ADDRESSES
        || records.some((record) => !isAllowedAddress(record.address))
      ) {
        throw new PinnedAddressBlockedError();
      }
      const wanted = lookupOptions.family === 4 || lookupOptions.family === 6
        ? records.filter((record) => record.family === lookupOptions.family)
        : records;
      if (wanted.length === 0) throw new PinnedAddressBlockedError();
      return wanted;
    })().then((addresses) => {
      if (lookupOptions.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    }, (error: unknown) => {
      if (!(error instanceof PinnedAddressBlockedError)) {
        console.warn("[pinned-fetch] Destination resolution failed:", error instanceof Error ? error.message : String(error));
      }
      const failure = error instanceof Error ? error : new Error("Destination resolution failed");
      callback(failure as NodeJS.ErrnoException, "", 0);
    });
  };
}

/**
 * Fetch for user-controlled destinations. Literal addresses are checked before
 * dispatch; hostnames are resolved and checked by the connection's own lookup.
 * The URL is unchanged, so Host and TLS SNI still name the requested hostname.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): PinnedFetch {
  const isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const dispatcher = new Agent({
    connect: { lookup: createValidatedLookup(options), timeout: timeoutMs },
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
  });

  return async (url, init) => {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new PinnedAddressBlockedError();
    }
    const literal = target.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(literal) !== 0 && !isAllowedAddress(literal)) {
      throw new PinnedAddressBlockedError();
    }
    const response = await undiciFetch(target, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
    return response as unknown as Response;
  };
}

let sharedPublicFetch: PinnedFetch | undefined;

/** Shared pinned fetch with the default public-address policy and system DNS. */
export function publicPinnedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  sharedPublicFetch ??= createPinnedFetch();
  return sharedPublicFetch(url, init);
}
