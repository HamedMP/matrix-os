import { createHostedMatrixMcpServer, type McpProfileContext } from '@finnaai/matrix/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { McpAuthError, type McpPrincipal } from './mcp-auth.js';

export interface McpRoutesOptions {
  resourceUrl: string;
  issuer: string;
  verify: (token: string) => Promise<McpPrincipal>;
  context: (principal: McpPrincipal) => McpProfileContext;
  fetch?: typeof fetch;
  allowedOrigins?: string[];
  requestTimeoutMs?: number;
  maxConcurrent?: number;
  requestsPerMinute?: number;
}

export function createMcpRoutes(options: McpRoutesOptions): Hono {
  const app = new Hono();
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', options.resourceUrl).toString();
  const allowedOrigins = options.allowedOrigins ?? [];
  const fetchImpl = options.fetch ?? fetch;
  // Per-process admission budgets; edge fleet-wide throttling is an additional layer.
  const maxConcurrent = options.maxConcurrent ?? 32;
  const perOwner = new Map<string, number>(); // At most maxConcurrent entries; deleted in finally.
  const windows = new Map<string, { count: number; until: number }>(); // 10k cap + TTL, no credential keys.
  let active = 0;
  let publicCount = 0;
  let publicUntil = 0;

  function allowPrincipal(userId: string): boolean {
    const now = Date.now();
    for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
    const window = windows.get(userId) ?? { count: 0, until: now + 60_000 };
    if (window.count >= (options.requestsPerMinute ?? 120)) return false;
    if (!windows.has(userId) && windows.size >= 10_000) return false;
    window.count++;
    windows.set(userId, window);
    return true;
  }

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, c => {
      c.header('Vary', 'Origin');
      const origin = c.req.header('origin');
      if (origin && !allowedOrigins.includes(origin)) return c.json({ error: 'Origin not allowed' }, 403);
      if (origin) c.header('Access-Control-Allow-Origin', origin);
      c.header('Cache-Control', 'public, max-age=300');
      return c.json({ resource: options.resourceUrl, authorization_servers: [options.issuer],
        scopes_supported: ['matrix:computer'], bearer_methods_supported: ['header'],
        resource_name: 'Matrix remote computers' });
    });
  }

  app.use('/mcp', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: c => c.json({ error: 'Request too large' }, 413) }));
  app.all('/mcp', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('Vary', 'Origin');
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.includes(origin)) return c.json({ error: 'Origin not allowed' }, 403);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, Retry-After');
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version');
      return c.body(null, 204);
    }
    const now = Date.now();
    if (publicUntil <= now) { publicUntil = now + 60_000; publicCount = 0; }
    if (++publicCount > 600 || active >= maxConcurrent) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Too many requests' }, 429);
    }
    const authorization = c.req.header('authorization');
    const token = authorization?.match(/^Bearer ([^\s]{1,16384})$/i)?.[1];
    if (!token) {
      c.header('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Include verification and body parsing in admission/deadline accounting.
    active++;
    let principal: McpPrincipal | undefined;
    let ownerAdmitted = false;
    let server: ReturnType<typeof createHostedMatrixMcpServer> | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
      options.requestTimeoutMs ?? 55_000);
    timer.unref();
    const onDisconnect = () => controller.abort(new DOMException('Request cancelled', 'AbortError'));
    c.req.raw.signal.addEventListener('abort', onDisconnect, { once: true });
    if (c.req.raw.signal.aborted) onDisconnect();
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    async function perform(): Promise<Response> {
      principal = await options.verify(token!);
      controller.signal.throwIfAborted();
      if (!allowPrincipal(principal.userId) || (perOwner.get(principal.userId) ?? 0) >= 4) {
        c.header('Retry-After', '60');
        return c.json({ error: 'Too many requests' }, 429);
      }
      perOwner.set(principal.userId, (perOwner.get(principal.userId) ?? 0) + 1);
      ownerAdmitted = true;
      if (c.req.method !== 'POST') {
        // Consume to engage bodyLimit even for DELETE, which usually has no body.
        await c.req.arrayBuffer();
        c.header('Allow', 'POST, OPTIONS');
        return c.json({ error: 'Method not allowed' }, 405);
      }
      if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
        return c.json({ error: 'Unsupported media type' }, 415);
      }
      let body: unknown;
      try { body = await c.req.json(); }
      catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        return c.json({ error: 'Invalid request' }, 400);
      }
      controller.signal.throwIfAborted();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid request' }, 400);
      const scopedFetch: typeof fetch = (input, init) => fetchImpl(input, { ...init,
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
      server = createHostedMatrixMcpServer({ context: options.context(principal), fetch: scopedFetch, maxCommandTimeoutMs: 45_000 });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      controller.signal.throwIfAborted();
      // A fresh server per request prevents identity or transport state crossing users.
      return transport.handleRequest(c.req.raw, { parsedBody: body });
    }
    try {
      return await Promise.race([perform(), aborted]);
    } catch (error: unknown) {
      if (error instanceof McpAuthError) {
        c.header('WWW-Authenticate', `Bearer error="${error.code}", resource_metadata="${metadataUrl}", scope="matrix:computer"`);
        return c.json({ error: error.status === 403 ? 'Insufficient scope' : 'Unauthorized' }, error.status);
      }
      if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'Request too large' }, 413);
      if (controller.signal.aborted) return c.json({ error: 'Request timed out or cancelled' }, 504);
      console.error('[mcp] request failed', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: 'MCP unavailable' }, 503);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAbort);
      c.req.raw.signal.removeEventListener('abort', onDisconnect);
      controller.abort();
      active--;
      if (principal && ownerAdmitted) {
        const remaining = (perOwner.get(principal.userId) ?? 1) - 1;
        if (remaining > 0) perOwner.set(principal.userId, remaining);
        else perOwner.delete(principal.userId);
      }
      if (server) await server.close();
    }
  });
  return app;
}
