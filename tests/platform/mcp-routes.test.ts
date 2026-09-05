import { Client } from '../../packages/platform/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../packages/platform/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMcpRoutes } from '../../packages/platform/src/mcp-routes.js';
import { McpAuthError } from '../../packages/platform/src/mcp-auth.js';

const resourceUrl = 'https://api.matrix-os.com/mcp';
const issuer = 'https://login.example.com';
const computer = { handle: 'alice-primary', runtimeSlot: 'primary', label: 'Main Computer' as const,
  availability: 'available' as const, kind: 'customer' as const, capabilities: [], gatewayPath: '/vm/alice-primary' };
const principal = { userId: 'user_alice', clientId: 'test', expiresAt: Math.floor(Date.now() / 1000) + 3600 };

function setup(overrides: Partial<Parameters<typeof createMcpRoutes>[0]> = {}) {
  const verify = vi.fn(async (token: string) => {
    if (token === 'read-only') throw new McpAuthError('insufficient_scope');
    if (token !== 'alice') throw new McpAuthError('invalid_token');
    return principal;
  });
  const context = vi.fn(() => ({
    listComputers: vi.fn(async () => ({ items: [computer], selectedSlot: null, hasMore: false, limit: 20 })),
    resolveRuntime: vi.fn(async () => ({ computer, gatewayUrl: 'https://app.matrix-os.com/vm/alice-primary', token: 'internal-only' })),
  }));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ stdout: 'remote\n', stderr: '', exitCode: 0,
    signal: null, timedOut: false, truncated: false, durationMs: 1 }));
  const app = new Hono().route('/', createMcpRoutes({ resourceUrl, issuer, verify, context, fetch, ...overrides }));
  return { app, verify, context, fetch };
}
function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request(resourceUrl, { method: 'POST', headers: { authorization: 'Bearer alice',
    'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
}
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

describe('hosted Streamable HTTP MCP', () => {
  it('publishes canonical public OAuth discovery independent of forwarded headers', async () => {
    const { app } = setup();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await app.request(path, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: resourceUrl, authorization_servers: [issuer], scopes_supported: ['matrix:computer'] });
    }
  });

  it('requires bearer auth and never accepts session cookies', async () => {
    const { app, context } = setup();
    const res = await post(app, rpc('tools/list'), { authorization: '', cookie: '__session=alice' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`${resourceUrl.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp`);
    expect(context).not.toHaveBeenCalled();
    expect((await post(app, rpc('tools/list'), { authorization: 'Bearer invalid' })).status).toBe(401);
    expect((await post(app, rpc('tools/list'), { authorization: 'Bearer read-only' })).status).toBe(403);
  });

  it('uses the real SDK client across initialize, list and tool calls without session state', async () => {
    const { app, context, fetch } = setup();
    const client = new Client({ name: 'http-smoke', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
      requestInit: { headers: { authorization: 'Bearer alice' } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(15);
      const result = await client.callTool({ name: 'list_computers', arguments: {} });
      expect(JSON.stringify(result)).toContain('alice-primary');
      const run = await client.callTool({ name: 'run_command', arguments: { computer: 'primary', command: ['pwd'] } });
      expect(run.isError).not.toBe(true);
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ command: ['pwd'], timeoutMs: 45_000 });
      expect(JSON.stringify(result)).not.toContain('internal-only');
      expect(context.mock.calls.length).toBeGreaterThanOrEqual(3);
      const invalid = await client.callTool({ name: 'run_command', arguments: { computer: 'primary', command: ['pwd'], timeoutMs: 46_000 } });
      expect(invalid.isError).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });

  it('rejects untrusted origins but supports configured browser preflight', async () => {
    const { app, verify } = setup({ allowedOrigins: ['https://trusted.example'] });
    expect((await post(app, rpc('tools/list'), { origin: 'https://evil.example' })).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    const preflight = await app.request(resourceUrl, { method: 'OPTIONS', headers: { origin: 'https://trusted.example', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://trusted.example');
    expect(preflight.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const discovery = await app.request(path, { headers: { origin: 'https://trusted.example' } });
      expect(discovery.headers.get('access-control-allow-origin')).toBe('https://trusted.example');
      expect(discovery.headers.get('vary')).toContain('Origin');
      expect((await app.request(path, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    }
  });

  it('bounds bodies and rejects batches and malformed JSON without invoking tools', async () => {
    const { app, context } = setup();
    expect((await post(app, { large: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
    expect((await post(app, [rpc('tools/list')])).status).toBe(400);
    const malformed = await app.request(resourceUrl, { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(context).not.toHaveBeenCalled();
  });

  it('returns 405 for authenticated GET/DELETE instead of inventing SSE/session routes', async () => {
    const { app } = setup();
    for (const method of ['GET', 'DELETE']) {
      const response = await app.request(resourceUrl, { method, headers: { authorization: 'Bearer alice' } });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toContain('POST');
    }
  });

  it('fails generically on authentication outages without leaking errors', async () => {
    const { app } = setup({ verify: async () => { throw new Error('private secret database detail'); } });
    const response = await post(app, rpc('tools/list'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
  });

  it('limits per-owner traffic without relying on spoofable forwarding headers', async () => {
    const { app } = setup({ requestsPerMinute: 1 });
    expect((await post(app, rpc('tools/list'))).status).toBe(200);
    expect((await post(app, rpc('tools/list'), { 'x-forwarded-for': '198.51.100.1' })).status).toBe(429);
  });

  it('aborts downstream requests at the deadline and releases concurrency', async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }));
    });
    const { app } = setup({ fetch, requestTimeoutMs: 30, maxConcurrent: 1 });
    const pending = post(app, rpc('tools/call', { name: 'run_command', arguments: { computer: 'primary', command: ['sleep', '10'] } }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce(), { interval: 1 });
    expect((await post(app, rpc('tools/list'))).status).toBe(429);
    expect((await pending).status).toBe(504);
    expect(signal?.aborted).toBe(true);
    expect((await post(app, rpc('tools/list'))).status).toBe(200);
  });

  it('cancels downstream work and releases admission when the client disconnects', async () => {
    let downstream: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      downstream = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => downstream?.addEventListener('abort', () => reject(downstream?.reason), { once: true }));
    });
    const { app } = setup({ fetch, maxConcurrent: 1 });
    const incoming = new AbortController();
    const pending = app.request(resourceUrl, { method: 'POST', signal: incoming.signal,
      headers: { authorization: 'Bearer alice', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(rpc('tools/call', { name: 'run_command', arguments: { computer: 'primary', command: ['sleep', '10'] } })) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce(), { interval: 1 });
    incoming.abort();
    expect((await pending).status).toBe(504);
    expect(downstream?.aborted).toBe(true);
    expect((await post(app, rpc('tools/list'))).status).toBe(200);
  });
});
