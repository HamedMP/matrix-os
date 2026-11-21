import type { Context } from 'hono';
import type { Agent } from 'undici';
import type { UserMachineRecord } from '../db.js';
import { sanitizeProxyResponseHeaders } from '../proxy-headers.js';
import { shouldForwardProxyHeader } from '../session-routing-proxy.js';
import type { SubstrateRegistry } from './registry.js';
import { applyUpstreamCredentials, dispatcherForUpstream, stripUpstreamCredentials } from './upstream-transport.js';

const LEGACY_PROXY_TIMEOUT_MS = 30_000;

/**
 * The platform-secret `/proxy/:handle/*` route for on-demand runtimes
 * (spec 2691, ENG-520). Its callers are not the runtime owner, so it never
 * wakes a runtime: a sleeping one answers 503 `runtime_unavailable`.
 */
export async function proxyLegacyRouteToSubstrate(c: Context, input: {
  substrates: SubstrateRegistry;
  machine: UserMachineRecord;
  path: string;
  queryString: string;
  vpsDispatcher: Agent;
  logRouteError: (context: string, err: unknown) => void;
}): Promise<Response> {
  const resolution = input.substrates.resolveUpstream(input.machine, { path: input.path, queryString: input.queryString });
  if (resolution.kind !== 'upstream') {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' }, 503);
  }
  const { upstream } = resolution;
  const headers = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    if (shouldForwardProxyHeader(key, value)) headers.set(key, value);
  }
  headers.set('host', upstream.hostHeader);
  headers.set('x-forwarded-host', c.req.header('host') ?? upstream.hostHeader);
  headers.set('x-forwarded-proto', 'https');
  headers.set('accept-encoding', 'identity');
  applyUpstreamCredentials(headers, upstream);
  try {
    const response = await fetch(upstream.url, {
      method: c.req.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(LEGACY_PROXY_TIMEOUT_MS),
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
      dispatcher: dispatcherForUpstream(upstream, input.vpsDispatcher),
    } as RequestInit & { dispatcher: Agent });
    const responseHeaders = sanitizeProxyResponseHeaders(response.headers);
    stripUpstreamCredentials(responseHeaders, upstream);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (err: unknown) {
    input.logRouteError('/proxy/:handle/* substrate', err);
    return c.json({ error: 'VPS unreachable' }, 502);
  }
}
