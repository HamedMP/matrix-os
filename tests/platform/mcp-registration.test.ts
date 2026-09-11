import { describe, expect, it } from 'vitest';
import { createPlatformMcpRoutes } from '../../packages/platform/src/mcp-registration.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

describe('platform MCP registration', () => {
  const db = {} as PlatformDB; // Discovery and misconfiguration must never access DB.
  it('fails closed when disabled or incompletely configured', async () => {
    for (const env of [{}, { MATRIX_MCP_ENABLED: 'true' }]) {
      const app = createPlatformMcpRoutes({ db, env });
      expect((await app.request('/mcp', { method: 'POST' })).status).toBe(503);
      expect((await app.request('/.well-known/oauth-protected-resource/mcp')).status).toBe(503);
    }
  });
  it('registers discovery without exposing deployment secrets', async () => {
    const app = createPlatformMcpRoutes({ db, env: {
      MATRIX_MCP_ENABLED: 'true', MATRIX_MCP_RESOURCE_URL: 'https://api.matrix-os.com/mcp',
      MATRIX_MCP_OAUTH_ISSUER: 'https://login.example.com', MATRIX_MCP_OAUTH_JWKS_URL: 'https://login.example.com/jwks',
      PLATFORM_JWT_SECRET: 'test-secret-at-least-thirty-two-characters',
    } });
    const response = await app.request('/.well-known/oauth-protected-resource/mcp');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('test-secret');
    const unauthorized = await app.request('/mcp');
    expect(unauthorized.status).toBe(401);
  });
  it('preserves the exact configured issuer including its trailing slash', async () => {
    const app = createPlatformMcpRoutes({ db, env: {
      MATRIX_MCP_ENABLED: 'true', MATRIX_MCP_RESOURCE_URL: 'https://api.matrix-os.com/mcp',
      MATRIX_MCP_OAUTH_ISSUER: 'https://login.example.com/',
      MATRIX_MCP_OAUTH_JWKS_URL: 'https://login.example.com/jwks',
      PLATFORM_JWT_SECRET: 'test-secret-at-least-thirty-two-characters',
    } });
    expect(await (await app.request('/.well-known/oauth-protected-resource/mcp')).json())
      .toMatchObject({ authorization_servers: ['https://login.example.com/'] });
  });
  it.each(['https://api.matrix-os.com/wrong', 'http://api.matrix-os.com/mcp', 'https://user:secret@api.matrix-os.com/mcp'])('rejects unsafe endpoint %s', async resourceUrl => {
    const app = createPlatformMcpRoutes({ db, env: { MATRIX_MCP_ENABLED: 'true', MATRIX_MCP_RESOURCE_URL: resourceUrl,
      MATRIX_MCP_OAUTH_ISSUER: 'https://login.example.com', MATRIX_MCP_OAUTH_JWKS_URL: 'https://login.example.com/jwks',
      PLATFORM_JWT_SECRET: 'test-secret-at-least-thirty-two-characters' } });
    expect((await app.request('/mcp')).status).toBe(503);
  });
});
