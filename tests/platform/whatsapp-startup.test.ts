import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createWhatsAppAgentClient } from '../../packages/platform/src/whatsapp/agent-client.js';
import type { createWhatsAppRoutes } from '../../packages/platform/src/whatsapp/routes.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';

const mocks = vi.hoisted(() => ({ machine: vi.fn(), entitlement: vi.fn(), repository: vi.fn(),
  agent: vi.fn(), service: vi.fn(), routes: vi.fn(), start: vi.fn(), shutdown: vi.fn() }));
vi.mock('../../packages/platform/src/db.js', () => ({ getRunningUserMachineByClerkId: mocks.machine }));
vi.mock('../../packages/platform/src/runtime-entitlement.js', () => ({ getRuntimeEntitlementDecisionForUser: mocks.entitlement }));
vi.mock('../../packages/platform/src/whatsapp/repository.js', () => ({ createWhatsAppRepository: mocks.repository }));
vi.mock('../../packages/platform/src/whatsapp/agent-client.js', () => ({ createWhatsAppAgentClient: mocks.agent }));
vi.mock('../../packages/platform/src/whatsapp/service.js', () => ({ createWhatsAppService: mocks.service }));
vi.mock('../../packages/platform/src/whatsapp/routes.js', () => ({ createWhatsAppRoutes: mocks.routes }));
import { createConfiguredWhatsAppRuntime } from '../../packages/platform/src/whatsapp/startup.js';

const configured = {
  WHATSAPP_APP_SECRET: 'test-app-secret', WHATSAPP_VERIFY_TOKEN: 'test-verification-token',
  WHATSAPP_ACCESS_TOKEN: 'private-access-token', WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_GRAPH_API_VERSION: 'v25.0', WHATSAPP_ENCRYPTION_KEY: 'a'.repeat(64),
  WHATSAPP_PUBLIC_URL: 'https://app.example.com', WHATSAPP_ALLOWED_SENDERS: '46700000000',
};
const enabled = { ...configured, PLATFORM_JWT_SECRET: 's'.repeat(32), CLERK_PUBLISHABLE_KEY: 'pk_test_fallback' };
const owner = 'user_owner';
const db = {} as Parameters<typeof createConfiguredWhatsAppRuntime>[0]['db'];
const primary = { machineId: 'machine_primary', clerkUserId: owner, provisioningClass: 'customer', runtimeSlot: 'primary', handle: 'owner' };
const verifyToken = vi.fn(async () => ({ sub: owner }));
const clerkAuth = createClerkAuth({ verifyToken });
type TargetResolver = Parameters<typeof createWhatsAppAgentClient>[0];
type RouteDependencies = Parameters<typeof createWhatsAppRoutes>[0];
function compose(env: NodeJS.ProcessEnv = enabled) { return createConfiguredWhatsAppRuntime({ db, env, clerkAuth }); }
function resolver(): TargetResolver { return mocks.agent.mock.calls[0]![0]; }
function routeDependencies(): RouteDependencies { return mocks.routes.mock.calls[0]![0]; }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.machine.mockResolvedValue(primary);
  mocks.entitlement.mockResolvedValue({ runtimeProxyAllowed: true });
  mocks.repository.mockReturnValue({ identity: 'repository' });
  mocks.agent.mockReturnValue({ identity: 'agent' });
  mocks.service.mockReturnValue({ start: mocks.start, shutdown: mocks.shutdown });
  mocks.routes.mockReturnValue({ identity: 'routes' });
  verifyToken.mockResolvedValue({ sub: owner });
});
afterEach(() => vi.useRealTimers());

describe('WhatsApp startup authorization', () => {
  it('disables absent config without constructing dependencies', () => {
    expect(compose({})).toBeUndefined();
    expect(mocks.repository).not.toHaveBeenCalled(); expect(mocks.machine).not.toHaveBeenCalled();
  });
  it('fails closed on partial config and missing authentication dependencies', () => {
    expect(() => compose({ WHATSAPP_APP_SECRET: 'only-one-field' })).toThrow();
    expect(() => createConfiguredWhatsAppRuntime({ env: enabled, db })).toThrow('WhatsApp authentication is unavailable');
    expect(() => compose(configured)).toThrow('WhatsApp authentication is unavailable');
    expect(() => compose({ ...configured, PLATFORM_JWT_SECRET: 's'.repeat(32) })).toThrow('WhatsApp authentication is unavailable');
    expect(mocks.repository).not.toHaveBeenCalled();
  });
  it('binds owner and primary slot into a fresh short-lived JWT', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const runtime = compose()!;
    const target = await resolver()(owner);
    expect(mocks.machine).toHaveBeenCalledWith(db, owner, 'primary');
    expect(mocks.entitlement).toHaveBeenCalledWith(db, owner, enabled, 'primary', 'customer');
    expect(target).toMatchObject({ machineId: primary.machineId, gatewayUrl: configured.WHATSAPP_PUBLIC_URL });
    const claims = await verifySyncJwt(target!.token, { secret: enabled.PLATFORM_JWT_SECRET });
    expect(claims).toMatchObject({ sub: owner, handle: primary.handle, runtime_slot: 'primary', gateway_url: configured.WHATSAPP_PUBLIC_URL });
    expect(claims.exp - claims.iat).toBe(60);
    vi.advanceTimersByTime(2000);
    expect((await resolver()(owner))!.token).not.toBe(target!.token);
    runtime.start(); await runtime.shutdown();
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({ repository: mocks.repository.mock.results[0]!.value, agent: mocks.agent.mock.results[0]!.value }));
  });
  it.each([null, { ...primary, clerkUserId: 'another_owner' }, { ...primary, provisioningClass: 'private-preview' }])(
    'refuses missing, foreign, or preview machines: %j', async (machine) => {
      mocks.machine.mockResolvedValue(machine); compose();
      expect(await resolver()(owner)).toBeNull(); expect(mocks.entitlement).not.toHaveBeenCalled();
    },
  );
  it('rechecks entitlement and refuses revoked runtime access', async () => {
    compose(); expect(await resolver()(owner)).not.toBeNull();
    mocks.entitlement.mockResolvedValue({ runtimeProxyAllowed: false });
    expect(await resolver()(owner)).toBeNull(); expect(mocks.entitlement).toHaveBeenCalledTimes(2);
  });
  it('propagates authoritative lookup failure without finding a fallback owner', async () => {
    mocks.machine.mockRejectedValue(new Error('database unavailable')); compose();
    await expect(resolver()(owner)).rejects.toThrow('database unavailable'); expect(mocks.entitlement).not.toHaveBeenCalled();
  });
  it('uses verified Clerk identity without returning rejected-token diagnostics', async () => {
    compose(); expect(routeDependencies().publishableKey).toBe('pk_test_fallback');
    expect(await routeDependencies().authenticate('owner-bearer')).toBe(owner);
    expect(verifyToken).toHaveBeenCalledWith('owner-bearer');
    verifyToken.mockRejectedValue(new Error('private auth diagnostic'));
    expect(await routeDependencies().authenticate('revoked-bearer')).toBeNull();
    verifyToken.mockResolvedValue({ sub: '' });
    expect(await routeDependencies().authenticate('missing-owner')).toBeNull();
  });
  it('prefers explicit public Clerk configuration', () => {
    compose({ ...enabled, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_public' });
    expect(routeDependencies().publishableKey).toBe('pk_test_public');
  });
});
