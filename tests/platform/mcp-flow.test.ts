import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { Client } from '../../packages/platform/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../packages/platform/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { createApp } from '../../packages/platform/src/main.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

it('composes signed OAuth, SDK HTTP, tenant lookup and attenuated gateway authentication', async () => {
  const { db } = await createTestPlatformDb();
  const resourceUrl = 'https://api.matrix-os.com/mcp';
  const issuer = 'https://login.example.com/';
  const secret = 'integration-only-runtime-secret-32-characters';
  const client = new Client({ name: 'signed-oauth-smoke', version: '1' });
  let network: ReturnType<typeof vi.spyOn> | undefined;
  try {
    for (const [user, slot] of [['alice', 'primary'], ['bob', 'private']]) {
      await insertUserMachine(db, { machineId: user, clerkUserId: 'user_' + user,
        handle: user + '-' + slot, runtimeSlot: slot, status: 'running',
        hetznerServerId: 100, publicIPv4: '203.0.113.10', serverType: 'cpx22',
        provisionedAt: '2026-09-05T00:00:00.000Z' });
    }
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ client_id: 'test-client', scope: 'matrix:computer' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer)
      .setAudience(resourceUrl).setSubject('user_alice').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const jwk = { ...await exportJWK(publicKey), kid: 'test' };
    const gatewayFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain('https://app.matrix-os.com/vm/alice-primary/');
      const internal = new Headers(init?.headers).get('authorization')!.slice(7);
      expect(internal).not.toBe(token);
      const claims = await verifySyncJwt(internal, { secret });
      expect(claims).toMatchObject({ sub: 'user_alice', handle: 'alice-primary', runtime_slot: 'primary' });
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ stdout: '/remote/home\n', stderr: '', exitCode: 0,
        signal: null, timedOut: false, truncated: false, durationMs: 1 });
    });
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      String(input) === issuer + 'jwks' ? Response.json({ keys: [jwk] }) : gatewayFetch(input, init));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-admin-secret',
      env: { MATRIX_MCP_ENABLED: 'true', MATRIX_MCP_RESOURCE_URL: resourceUrl,
        MATRIX_MCP_OAUTH_ISSUER: issuer, MATRIX_MCP_OAUTH_JWKS_URL: issuer + 'jwks',
        PLATFORM_JWT_SECRET: secret, NEXT_PUBLIC_MATRIX_APP_URL: 'https://app.matrix-os.com' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), {
      requestInit: { headers: { authorization: 'Bearer ' + token } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    }));
    const inventory = JSON.stringify(await client.callTool({ name: 'list_computers', arguments: {} }));
    expect(inventory).toContain('alice-primary');
    expect(inventory).not.toContain('bob');
    const run = await client.callTool({ name: 'run_command', arguments: { computer: 'primary', command: ['pwd'] } });
    expect(run.isError).not.toBe(true);
    expect(JSON.stringify(run)).toContain('/remote/home');
    expect(JSON.stringify(run)).not.toContain(token);
    expect(JSON.stringify(run)).not.toContain(secret);
    const denied = await client.callTool({ name: 'run_command', arguments: { computer: 'private', command: ['pwd'] } });
    expect(denied.isError).toBe(true);
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    network?.mockRestore();
    await destroyTestPlatformDb(db);
  }
});
