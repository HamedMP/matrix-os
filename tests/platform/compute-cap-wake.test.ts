import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStateResponseSchema } from '@matrix-os/contracts';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { DEFAULT_COMPUTE_CAP_CONFIG, monthStartUtc, nextMonthStartUtc } from '../../packages/platform/src/free-tier/compute-meter.js';
import { createApp } from '../../packages/platform/src/main.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import { isExportOnlyRequest } from '../../packages/platform/src/substrates/container-wake.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const OWNER = 'user_capwake';
const ENDPOINT = 'mvm-1.lambda-microvm.eu-west-1.on.aws';
const OWNER_SESSION = { host: 'app.matrix-os.com', authorization: `Bearer ${OWNER}` };
const EXPORT = { ...OWNER_SESSION, 'x-matrix-export': '1' };

function fakeProvider(): ContainerProvider {
  const unit: ContainerUnit = {
    unitId: 'mvm-1', state: 'pending', endpointHost: ENDPOINT, createdAt: new Date(), expiresAt: new Date(Date.now() + 8 * 3_600_000),
  };
  return {
    run: vi.fn(async () => unit),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: { 'X-aws-proxy-auth': 'minted' }, expiresAt: new Date(Date.now() + 30 * 60_000) })),
  };
}

describe('waking a runtime at the compute cap', () => {
  let db: PlatformDB;
  let provider: ContainerProvider;
  let lifecycle: ReturnType<typeof createContainerLifecycleService>;
  let platform: ReturnType<typeof createApp>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('runtime', { status: 200 }));
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'capwake', status: 'stopped', imageVersion: null,
      provisionedAt: new Date().toISOString(), substrate: 'container',
    });
    await db.executor.insertInto('runtime_compute_usage').values({
      clerk_user_id: OWNER, month_start: monthStartUtc(new Date()).toISOString().slice(0, 10),
      billed_ms: DEFAULT_COMPUTE_CAP_CONFIG.capMs, export_ms: 0, export_wakes: 0,
    }).execute();
    provider = fakeProvider();
    lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}', computeCap: DEFAULT_COMPUTE_CAP_CONFIG });
    const container = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId),
    });
    platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123', env: {},
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      substrateRegistry: createSubstrateRegistry([createVpsSubstrate({ loadMachine: async () => undefined }), container]),
    });
  });

  afterEach(async () => {
    await lifecycle.shutdown();
    await shutdownPlatformApp(platform);
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  async function expectLimit(response: Response) {
    expect(response.status).toBe(429);
    const body = RuntimeStateResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ runtimeState: 'limit_reached', limit: 'compute', resetsAt: nextMonthStartUtc(new Date()).toISOString() });
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(Number.isSafeInteger(retryAfter) && retryAfter > 0).toBe(true);
    expect(Math.abs(Date.now() + retryAfter * 1_000 - Date.parse(body.resetsAt!))).toBeLessThan(5_000);
  }

  it('refuses an ordinary owner request with limit_reached and a reset time, without starting compute', async () => {
    await expectLimit(await platform.request('/api/projects', { headers: OWNER_SESSION }));
    await expectLimit(await platform.request('/api/system/export', { headers: OWNER_SESSION }));
    const page = await platform.request('/vm/capwake/', { headers: { ...OWNER_SESSION, 'sec-fetch-mode': 'navigate' } });
    expect(page.status).toBe(429);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).not.toContain('http-equiv="refresh"');
    expect(provider.run).not.toHaveBeenCalled();
  });

  it('starts an export-only unit for a verified export request and admits only export and reads', async () => {
    const waking = await platform.request('/api/system/export', { headers: EXPORT });
    expect(waking.status).toBe(503);
    expect(await waking.json()).toMatchObject({ runtimeState: 'waking' });
    await lifecycle.drain();
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    expect(machine.computeMode).toBe('export_only');
    expect(await lifecycle.markRegistered('ctr-1', machine.generation)).toBe('ok');

    expect((await platform.request('/api/system/export', { headers: EXPORT })).status).toBe(200);
    expect((await platform.request('/api/chats?limit=20', { headers: OWNER_SESSION })).status).toBe(200);
    expect((await platform.request('/api/files/list?path=notes', { headers: OWNER_SESSION })).status).toBe(200);
    await expectLimit(await platform.request('/api/chats', { method: 'POST', headers: OWNER_SESSION, body: '{}' }));
    await expectLimit(await platform.request('/api/projects', { headers: OWNER_SESSION }));
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
  it('treats the explicit ~runtime/<slot> route like the plain one at the cap', async () => {
    const base = '/vm/capwake/~runtime/primary';
    // Explicit /vm routes answer with the HTML pages, so the statuses carry the decision here.
    expect((await platform.request(`${base}/api/projects`, { headers: OWNER_SESSION })).status).toBe(429);
    expect(provider.run).not.toHaveBeenCalled();
    expect((await platform.request(`${base}/api/system/export`, { headers: EXPORT })).status).toBe(503);
    await lifecycle.drain();
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    expect(machine.computeMode).toBe('export_only');
    expect(await lifecycle.markRegistered('ctr-1', machine.generation)).toBe('ok');

    expect((await platform.request(`${base}/api/system/export`, { headers: EXPORT })).status).toBe(200);
    expect((await platform.request(`${base}/api/chats?limit=20`, { headers: OWNER_SESSION })).status).toBe(200);
    expect((await platform.request(`${base}/api/projects`, { headers: OWNER_SESSION })).status).toBe(429);
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
});

describe('export-only request allowlist', () => {
  const request = (method: string, path: string, headers: Record<string, string> = {}) => ({
    method, path, header: (name: string) => headers[name.toLowerCase()],
  });

  it('admits the export route and read-only file and Chat history reads', () => {
    expect(isExportOnlyRequest(request('GET', '/api/system/export', { 'x-matrix-export': '1' }))).toBe(true);
    for (const path of ['/api/files/list', '/api/files/stat', '/api/files/tree', '/api/files/search', '/files/notes/a.md',
      '/api/chats', '/api/chats/search', '/api/chats/chat_1', '/api/conversations', '/api/conversations/c-1']) {
      expect(isExportOnlyRequest(request('GET', path)), path).toBe(true);
    }
  });

  it('refuses writes, other routes, traversal, encoded separators, and upgrades', () => {
    for (const [method, path, headers] of [
      ['GET', '/api/system/export', {}],
      ['POST', '/api/system/export', { 'x-matrix-export': '1' }],
      ['POST', '/api/chats', {}],
      ['DELETE', '/api/conversations/c-1', {}],
      ['GET', '/api/chats/chat_1/credentials', {}],
      ['GET', '/api/chats/events', {}],
      ['GET', '/files/../system/secrets.json', {}],
      ['GET', '/files/notes%2f..%2fsecret', {}],
      ['GET', '/api/terminal/workspaces', {}],
      ['GET', '/api/chats', { upgrade: 'websocket' }],
    ] as const) {
      expect(isExportOnlyRequest(request(method, path, headers)), `${method} ${path}`).toBe(false);
    }
  });
});
