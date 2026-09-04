import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemUpdateRoutes } from '../../packages/gateway/src/system-update-routes';
import { createManagedUpdatePolicy } from '../../packages/gateway/src/managed-update-policy';
import { startSystemUpdate } from '../../packages/gateway/src/system-update';
import * as updates from '../../packages/gateway/src/system-update';
vi.mock('../../packages/gateway/src/system-update', async importOriginal => ({
  ...await importOriginal<object>(), startSystemUpdate: vi.fn(async () => ({ ok: true, status: 'started' })),
}));
function app(busy = false, capture = vi.fn(async () => undefined)) {
  return createSystemUpdateRoutes({ getInfo: () => ({ release: { version: 'v2026.08.01-1', channel: 'stable' } }) as never,
    policy: createManagedUpdatePolicy({ env: { MATRIX_MACHINE_ID: 'machine_1', UPGRADE_TOKEN: 'operator' } }), isBusy: () => busy, capture });
}
const req = (body: unknown, auth = 'customer') => ({ method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
describe('managed update route wiring', () => {
  afterEach(() => vi.restoreAllMocks());
  it('rejects direct user version changes on both legacy aliases and repair', async () => {
    for (const path of ['/update', '/upgrade', '/update/repair']) expect((await app().request(path, req({ version: 'v2026.08.28-1' }))).status).toBe(403);
  });
  it('lets the machine operator install an immutable bridge version', async () => {
    const response = await app().request('/update', req({ version: 'v2026.08.28-1' }, 'operator'));
    expect(response.status).toBe(202);
    expect(startSystemUpdate).toHaveBeenCalledWith({ target: { type: 'version', value: 'v2026.08.28-1' } });
  });
  it('defers updates while the kernel is busy and rejects malformed payloads', async () => {
    expect((await app(true).request('/update', req({ version: 'v2026.08.28-1' }, 'operator'))).status).toBe(409);
    expect((await app().request('/update', { ...req({}, 'operator'), body: 'invalid' })).status).toBe(400);
  });
  it('never treats an unreadable or oversized body as an empty update request', async () => {
    const unreadable = new ReadableStream({ start(controller) { controller.error(new TypeError('broken body')); } });
    const headers = { ...req({}, 'operator').headers, 'content-length': '2' };
    const response = await app().request('/update', { method: 'POST', headers, body: unreadable, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(400);
    expect((await app().request('/update', { ...req({}, 'operator'), body: JSON.stringify({ version: 'x'.repeat(5000) }) })).status).toBe(413);
  });
  it('forces stable discovery for customers while retaining operator diagnostics', async () => {
    const check = vi.spyOn(updates, 'checkForSystemUpdate').mockResolvedValue({ updateAvailable: false } as never);
    const releases = vi.spyOn(updates, 'listSystemReleases').mockResolvedValue({ releases: [] } as never);
    vi.spyOn(updates, 'readSystemUpdateFailure').mockResolvedValue(null);
    expect((await app().request('/update?channel=canary')).status).toBe(200);
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'stable' }));
    expect((await app().request('/releases?channel=dev')).status).toBe(200);
    expect(releases).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'stable' }));
    for (const path of ['/update?channel=invalid', '/releases?channel=invalid']) {
      expect((await app().request(path, { headers: { authorization: 'Bearer operator' } })).status).toBe(400);
    }
  });
  it('resolves channel aliases to immutable versions and keeps repair operator-only', async () => {
    vi.spyOn(updates, 'resolveInternalUpgradeInstallTarget').mockResolvedValue({ type: 'version', value: 'v2026.08.28-1' });
    const repair = vi.spyOn(updates, 'startSystemUpdateRepair').mockResolvedValue({ ok: true, status: 'started' } as never);
    const response = await app().request('/upgrade', req({ channel: 'stable' }, 'operator'));
    expect(await response.json()).toMatchObject({ channel: 'stable', version: 'v2026.08.28-1' });
    expect((await app().request('/update/repair', req({}, 'operator'))).status).toBe(202);
    expect(repair).toHaveBeenCalledOnce();
    repair.mockResolvedValue({ ok: false } as never);
    expect((await app().request('/update/repair', req({}, 'operator'))).status).toBe(503);
  });
  it('returns generic failures and never dispatches an unresolved release', async () => {
    const resolve = vi.spyOn(updates, 'resolveInternalUpgradeInstallTarget').mockRejectedValueOnce(new Error('private upstream detail'));
    const response = await app().request('/update', req({ channel: 'stable' }, 'operator'));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('upstream');
    resolve.mockResolvedValue({ type: 'version', value: 'v2026.08.28-1' });
    vi.mocked(startSystemUpdate).mockResolvedValueOnce({ ok: false } as never);
    expect((await app().request('/update', req({ version: 'v2026.08.28-1' }, 'operator'))).status).toBe(503);
    expect((await app().request('/update', req({ version: '../bad' }, 'operator'))).status).toBe(400);
  });
  it('keeps accepted updates successful if telemetry is unavailable', async () => {
    vi.spyOn(updates, 'startSystemUpdateRepair').mockResolvedValue({ ok: true, status: 'started' } as never);
    const capture = vi.fn(async () => { throw new Error('telemetry unavailable'); });
    for (const path of ['/update', '/update/repair']) {
      expect((await app(false, capture).request(path, req({ version: 'v2026.08.28-1' }, 'operator'))).status).toBe(202);
    }
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
