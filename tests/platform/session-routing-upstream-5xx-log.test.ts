import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { appDomainPathClass } from '../../packages/platform/src/app-domain-shell-routing.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * An app-domain request that gets a 5xx from the platform auth shell (Next on
 * :3200) or from the owner's runtime used to pass through with no platform log
 * line (live: intermittent bare 500s on "/" right after sign-in). The platform
 * now logs which upstream answered, the method, the path without its query and
 * whether it was a Next server action. Fault detected: an unexplained 500.
 */

const CLERK_SESSION = { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' };

describe('app-domain upstream 5xx logging', () => {
  let db: PlatformDB;
  let errors: string[];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  function platform() {
    return createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
    });
  }

  it('logs an auth-shell 500 with its path but never the query', async () => {
    const res = await platform().request('/?plans=1&token=secret', { headers: CLERK_SESSION });

    expect(res.status).toBe(500);
    const line = errors.find((entry) => entry.includes('auth-shell upstream'));
    expect(line).toBe('[platform] app-domain auth-shell upstream status=500 method=GET path_class=/ server_action=false');
    expect(errors.join('\n')).not.toContain('secret');
  });

  it('logs a runtime 500 for a Next server action POST with the runtime handle', async () => {
    await insertUserMachine(db, {
      machineId: 'machine-alice', clerkUserId: 'user_alice', handle: 'alice', status: 'running',
      hetznerServerId: 4242, publicIPv4: '203.0.113.50', imageVersion: 'matrix-os-host-dev', provisionedAt: '2026-11-01T00:00:00.000Z',
    });

    const res = await platform().request('/', {
      method: 'POST', headers: { ...CLERK_SESSION, 'next-action': 'abc123', 'content-type': 'text/plain' }, body: '[]',
    });

    expect(res.status).toBe(500);
    expect(errors.find((entry) => entry.includes('runtime upstream')))
      .toBe('[platform] app-domain runtime upstream status=500 method=POST path_class=/ server_action=true handle=alice');
  });

  it('logs a route class, never user content from the path', () => {
    expect(appDomainPathClass('/')).toBe('/');
    expect(appDomainPathClass('/api/journey')).toBe('/api/journey');
    expect(appDomainPathClass('/api/chats/chat_58ed/interactions')).toBe('/api/chats/*');
    expect(appDomainPathClass('/files/home/Taxes 2026 private.pdf')).toBe('/files/*');
    expect(appDomainPathClass('/shared/invitations/inv_secret123')).toBe('/shared/*');
    expect(appDomainPathClass('/_next/static/chunks/app.js')).toBe('/_next/*');
    expect(appDomainPathClass('/__platform-shell/_next/static/x.js')).toBe('/__platform-shell/*');
    expect(appDomainPathClass('/sign-in')).toBe('/sign-in');
    expect(appDomainPathClass('/api/Bad Group/x')).toBe('other');
    expect(appDomainPathClass('/my-private-app/page')).toBe('other');
  });
});
