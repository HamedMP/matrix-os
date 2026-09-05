import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PlatformDB } from './db.js';
import { createMcpTokenVerifier } from './mcp-auth.js';
import { createMcpRoutes } from './mcp-routes.js';
import { createMcpRuntimeContext } from './mcp-runtime-context.js';

function secureUrl(raw: string, path?: string): URL {
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.hash || url.search || (path !== undefined && url.pathname !== path)) {
    throw new Error('Invalid MCP configuration');
  }
  return url;
}

/** Keep hosted auth/composition out of the platform entrypoint and CLI profile loader. */
export function createPlatformMcpRoutes(options: { db: PlatformDB; env: NodeJS.ProcessEnv }): Hono {
  const unavailable = () => {
    const app = new Hono();
    app.use('/mcp', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
    for (const path of ['/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      app.all(path, c => { c.header('Cache-Control', 'no-store'); return c.json({ error: 'MCP unavailable' }, 503); });
    }
    return app;
  };
  const env = options.env;
  if (env.MATRIX_MCP_ENABLED !== 'true') return unavailable();
  try {
    const resourceUrl = secureUrl(env.MATRIX_MCP_RESOURCE_URL ?? '', '/mcp').href;
    const issuer = env.MATRIX_MCP_OAUTH_ISSUER ?? '';
    secureUrl(issuer); // JWT issuer comparison is exact; do not normalize trailing slashes.
    const jwksUrl = secureUrl(env.MATRIX_MCP_OAUTH_JWKS_URL ?? '').href;
    const gatewayOrigin = secureUrl(env.NEXT_PUBLIC_MATRIX_APP_URL ?? 'https://app.matrix-os.com', '/').origin;
    const jwtSecret = env.PLATFORM_JWT_SECRET ?? '';
    if (jwtSecret.length < 32) throw new Error('Invalid MCP configuration');
    const rawOrigins = env.MATRIX_MCP_ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    if (rawOrigins.length > 20) throw new Error('Too many MCP origins');
    const allowedOrigins = rawOrigins.map(value => secureUrl(value, '/').origin);
    const verify = createMcpTokenVerifier({ resourceUrl, issuer, jwksUrl });
    return createMcpRoutes({ resourceUrl, issuer, allowedOrigins, verify,
      context: principal => createMcpRuntimeContext({ db: options.db, principal, gatewayOrigin, jwtSecret }) });
  } catch (error: unknown) {
    console.error('[mcp] configuration unavailable', error instanceof Error ? error.name : 'UnknownError');
    return unavailable();
  }
}
