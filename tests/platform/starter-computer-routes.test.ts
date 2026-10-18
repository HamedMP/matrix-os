import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const inventory = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../packages/platform/src/computer-repository.js', () => ({ listUserRuntimeComputersByClerkId: inventory.list }));
import { createComputerRoutes } from '../../packages/platform/src/computer-routes.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

const entries = [
  { ownerId: 'user_hamed', handle: 'hamed', origin: 'https://hamed-pilot.workers.dev', token: 'h'.repeat(48) },
  { ownerId: 'user_nima', handle: 'nima', origin: 'https://nima-pilot.workers.dev', token: 'n'.repeat(48) },
];
const personal = { handle: 'hamed', runtimeSlot: 'primary', provisioningClass: 'customer', status: 'running', imageVersion: 'stable' };
function app(ownerId = 'user_hamed', registry = JSON.stringify(entries)) {
  return createComputerRoutes({ db: {} as PlatformDB, platformJwtSecret: 'test-secret', legacyContainerRoutingEnabled: false,
    resolveIdentity: vi.fn().mockResolvedValue({ userId: ownerId, source: 'auth', runtimeSlot: 'primary' }),
    appEnv: { MATRIX_SHARED_WORKSPACE_SPIKE: '1', MATRIX_STARTER_COMPUTERS: registry },
    applyNoStoreHeaders: (c) => c.header('Cache-Control', 'private, no-store'), logRouteError: vi.fn(), getGatewayUrlForHandle: (handle) => `/vm/${handle}` });
}
beforeEach(() => inventory.list.mockResolvedValue([personal]));
afterEach(() => vi.clearAllMocks());
describe('allowlisted Starter computer inventory', () => {
  it('adds a separate Starter without changing the existing VPS or its selection', async () => {
    const response = await app().request('/api/auth/computers?include=starter');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.selectedSlot).toBe('primary');
    expect(body.items[0]).toMatchObject({ handle: 'hamed', runtimeSlot: 'primary', kind: 'customer', gatewayPath: '/vm/hamed' });
    expect(body.items[1]).toMatchObject({ label: 'Starter Computer', runtimeSlot: 'starter', kind: 'starter', gatewayPath: '/workspace' });
    expect(JSON.stringify(body)).not.toMatch(/user_hamed|user_nima|workers\.dev|hhhhhh|nnnnnn|nima/);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('keeps the native inventory unchanged and never adds another owner\'s Starter', async () => {
    expect((await (await app().request('/api/auth/computers')).json()).items).toHaveLength(1);
    expect((await (await app('user_other').request('/api/auth/computers?include=starter')).json()).items).toHaveLength(1);
    const nima = await (await app('user_nima').request('/api/auth/computers?include=starter')).json();
    expect(nima.items[1]).toMatchObject({ handle: 'nima', kind: 'starter' });
  });
  it('keeps personal inventory usable when pilot configuration is invalid', async () => {
    const response = await app('user_hamed', '{invalid').request('/api/auth/computers?include=starter');
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
  });
  it('does not replace an existing personal starter slot or overflow the inventory cap', async () => {
    inventory.list.mockResolvedValue([{ ...personal, runtimeSlot: 'starter' }, personal]);
    expect((await (await app().request('/api/auth/computers?include=starter')).json()).items).toHaveLength(2);
    inventory.list.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ ...personal, runtimeSlot: i === 0 ? 'primary' : `slot-${i}` })));
    const body = await (await app().request('/api/auth/computers?include=starter')).json();
    expect(body.items).toHaveLength(20);
    expect(body.items.every((item: { kind: string }) => item.kind === 'customer')).toBe(true);
  });
});
