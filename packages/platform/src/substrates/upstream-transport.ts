import { rootCertificates } from 'node:tls';
import { isIP } from 'node:net';
import { Agent, buildConnector, type Dispatcher } from 'undici';
import { CUSTOMER_VPS_KEEP_ALIVE_MAX_TIMEOUT_MS, CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS } from '../customer-vps-dispatcher.js';
import { HOST_AUTH_HEADER } from './metal-substrate.js';
import type { RuntimeUpstream } from './types.js';

/**
 * Transport details a substrate upstream asks for (spec 2691, ENG-520):
 * credentials the platform adds to every proxied request, and TLS that
 * verifies the upstream against the system roots plus an optional extra CA
 * under the upstream's own server name. Plain VPS upstreams ask for none of
 * this and keep the shared customer VPS dispatcher unchanged.
 */

/**
 * The fetch API always sends the URL authority as Host, but a host ingress routes by
 * the runtime's handle Host. The platform passes the wanted Host in this
 * internal header and the verified dispatcher turns it into the real Host.
 */
export const UPSTREAM_HOST_HEADER = 'x-matrix-upstream-host';
/** Header names that only the platform may set toward a runtime, never a client. */
const RESERVED_UPSTREAM_HEADERS = [HOST_AUTH_HEADER, UPSTREAM_HOST_HEADER] as const;
const MAX_VERIFIED_DISPATCHERS = 32;

function credentialNames(upstream: RuntimeUpstream): string[] {
  return [...RESERVED_UPSTREAM_HEADERS, ...Object.keys(upstream.headers ?? {}).map((name) => name.toLowerCase())];
}

/**
 * Removes any client-sent copy of a reserved credential, then sets the
 * upstream's own credentials last so a client header of the same name cannot
 * replace them.
 */
export function applyUpstreamCredentials(headers: Headers, upstream: RuntimeUpstream): void {
  for (const name of RESERVED_UPSTREAM_HEADERS) headers.delete(name);
  for (const [name, value] of Object.entries(upstream.headers ?? {})) headers.set(name, value);
  if (needsVerifiedTransport(upstream)) headers.set(UPSTREAM_HOST_HEADER, upstream.hostHeader);
}

/** Never hand a runtime credential back to the client, even if the upstream echoes it. */
export function stripUpstreamCredentials(headers: Headers, upstream: RuntimeUpstream): void {
  for (const name of credentialNames(upstream)) headers.delete(name);
}

/** True for a header line (`name: value`) that carries a credential name. */
export function isCredentialHeaderLine(line: string, upstream: RuntimeUpstream): boolean {
  const colon = line.indexOf(':');
  if (colon <= 0) return false;
  return credentialNames(upstream).includes(line.slice(0, colon).trim().toLowerCase());
}

export function needsVerifiedTransport(upstream: RuntimeUpstream): boolean {
  return Boolean(upstream.tlsServerName || upstream.extraCaPem || upstream.headers);
}

export function trustedCaList(upstream: RuntimeUpstream): string[] | undefined {
  return upstream.extraCaPem ? [...rootCertificates, upstream.extraCaPem] : undefined;
}

type DispatchHeaders = Dispatcher.DispatchOptions['headers'];

/** Replaces Host with the internal upstream-host header's value and drops that header. */
export function withUpstreamHost(headers: DispatchHeaders): DispatchHeaders {
  const entries: Array<[string, string | string[]]> = [];
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      entries.push([String(headers[index]), headers[index + 1] as string | string[]]);
    }
  } else if (headers && typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const [name, value] of headers as Iterable<[string, string | string[] | undefined]>) {
      if (value !== undefined) entries.push([name, value]);
    }
  } else if (headers) {
    for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
      if (value !== undefined) entries.push([name, value]);
    }
  }
  const wanted = entries.find(([name]) => name.toLowerCase() === UPSTREAM_HOST_HEADER)?.[1];
  if (typeof wanted !== 'string') return headers;
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (lower !== UPSTREAM_HOST_HEADER && lower !== 'host') result[name] = value;
  }
  result.host = wanted;
  return result;
}

// Insertion-ordered LRU of verified dispatchers keyed by server name and CA; evicted ones are closed.
const verifiedDispatchers = new Map<string, Dispatcher>();

function verifiedDispatcher(upstream: RuntimeUpstream): Dispatcher {
  const key = `${upstream.tlsServerName ?? ''}\n${upstream.extraCaPem ?? ''}`;
  const existing = verifiedDispatchers.get(key);
  if (existing) {
    verifiedDispatchers.delete(key);
    verifiedDispatchers.set(key, existing);
    return existing;
  }
  const ca = trustedCaList(upstream);
  const connector = buildConnector({ rejectUnauthorized: true, ...(ca ? { ca } : {}) });
  // undici derives SNI and the certificate check from the Host header, which here names the
  // runtime, not the ingress. Pin both to the upstream's TLS server name (an IP verifies by address).
  const tlsServerName = upstream.tlsServerName && !isIP(upstream.tlsServerName) ? upstream.tlsServerName : undefined;
  const agent = new Agent({
    pipelining: 1,
    keepAliveTimeout: CUSTOMER_VPS_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: CUSTOMER_VPS_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connect: (options, callback) => connector({ ...options, servername: tlsServerName }, callback),
  }).compose((dispatch) => (options, handler) => dispatch({ ...options, headers: withUpstreamHost(options.headers) }, handler));
  verifiedDispatchers.set(key, agent);
  while (verifiedDispatchers.size > MAX_VERIFIED_DISPATCHERS) {
    const [oldestKey, oldest] = verifiedDispatchers.entries().next().value as [string, Dispatcher];
    verifiedDispatchers.delete(oldestKey);
    oldest.close().catch((error: unknown) => {
      console.warn('[upstream-transport] evicted dispatcher close failed', error instanceof Error ? error.name : 'unknown');
    });
  }
  return agent;
}

/**
 * The dispatcher for one proxied request: verified TLS for upstreams that
 * name a server or CA or carry credentials, the caller's VPS pool otherwise.
 */
export function dispatcherForUpstream(upstream: RuntimeUpstream, vpsDispatcher: Agent): Dispatcher {
  return needsVerifiedTransport(upstream) ? verifiedDispatcher(upstream) : vpsDispatcher;
}

/** Closes pooled verified dispatchers (platform shutdown). */
export async function closeUpstreamDispatchers(): Promise<void> {
  const agents = [...verifiedDispatchers.values()];
  verifiedDispatchers.clear();
  await Promise.allSettled(agents.map((agent) => agent.close()));
}
