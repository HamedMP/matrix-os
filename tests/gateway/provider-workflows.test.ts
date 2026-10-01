import { describe, expect, it, vi } from 'vitest';
import { createProviderWorkflowService } from '../../packages/gateway/src/ai-providers/provider-workflows.js';
import { createProviderWorkflowRoutes } from '../../packages/gateway/src/ai-providers/provider-workflow-routes.js';

const request = { harnessInstanceId: 'codex', kind: 'login' as const, method: 'device_code' as const, idempotencyKey: 'request-1' };
function fixture() {
  const cancel = vi.fn(async () => {});
  const start = vi.fn(async () => ({ cancel, terminalSessionId: 'tws_test:tt_test' }));
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: [], install: false, uninstall: false, start }], now: () => new Date('2026-10-01T00:00:00Z') });
  return { service, start, cancel };
}
describe('provider workflows', () => {
  it('deduplicates exact requests and rejects cross-owner access', async () => {
    const { service, start } = fixture();
    const first = await service.start('owner', request);
    expect(await service.start('owner', request)).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(service.status('other', first.id)).rejects.toThrow();
    await expect(service.start('owner', { ...request, kind: 'install' })).rejects.toThrow();
  });
  it('cancels the actual adapter before publishing cancellation and ignores late events', async () => {
    const { service, start, cancel } = fixture();
    const first = await service.start('owner', request);
    await service.cancel('owner', first.id);
    expect(cancel).toHaveBeenCalledOnce();
    const publish = start.mock.calls[0]![0].publish;
    publish({ state: 'succeeded' });
    expect((await service.status('owner', first.id)).state).toBe('cancelled');
  });
  it('does not expose raw output or advertise absent key adapters', async () => {
    const { service } = fixture();
    expect((await service.capabilities('owner'))[0]!.apiKeyProviders).toEqual([]);
    await expect(service.verifyKey('owner', { harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-test-secret' })).rejects.toThrow();
  });
  it('requires authentication and bounds bodies at the HTTP boundary', async () => {
    const { service } = fixture();
    const app = createProviderWorkflowRoutes({ service, getPrincipal: () => null });
    const denied = await app.request('/provider-settings/workflows/capabilities');
    expect(denied.status).toBe(401); expect(denied.headers.get('Cache-Control')).toBe('private, no-store');
    const authed = createProviderWorkflowRoutes({ service, getPrincipal: () => ({ userId: 'owner' }) });
    expect((await authed.request('/provider-settings/workflows', { method: 'POST', body: JSON.stringify({ ...request, command: 'rm -rf' }), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await authed.request('/provider-settings/workflows/keys', { method: 'POST', body: 'x'.repeat(9000) })).status).toBe(413);
  });
});
it('clears device authorization when an adapter fails after publishing a code', async () => {
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: [], install: false, uninstall: false,
    async start({ publish }) { publish({ deviceCode: 'ABCD-EFGH', authorizationUrl: 'https://auth.openai.com/codex/device' }); throw new Error('synthetic startup failure'); },
  }] });
  expect(await service.start('owner', request)).toMatchObject({ state: 'failed', deviceCode: null, authorizationUrl: null });
});
it('rejects key replacement while the same native profile has an active workflow', async () => {
  const verifyKey = vi.fn(async () => {});
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: ['openai'], install: false, uninstall: false, verifyKey,
    async start() { return { cancel: async () => {} }; },
  }] });
  await service.start('owner', request);
  await expect(service.verifyKey('owner', { harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-synthetic-fixture' })).rejects.toThrow('conflict');
  expect(verifyKey).not.toHaveBeenCalled();
  await service.close();
});
it('serializes configured instances that share one native harness profile', async () => {
  const adapter = { harness: 'codex' as const, displayName: 'Codex', installState: 'installed' as const, loginMethods: ['device_code' as const], apiKeyProviders: [], install: false, uninstall: false, async start() { return { cancel: async () => {} }; } };
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ ...adapter, harnessInstanceId: 'codex' }, { ...adapter, harnessInstanceId: 'codex_secondary' }] });
  await service.start('owner', request);
  await expect(service.start('owner', { ...request, harnessInstanceId: 'codex_secondary', idempotencyKey: 'secondary' })).rejects.toThrow('conflict');
  await service.close();
});
it('rejects new work immediately when shutdown is queued behind an in-flight start', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = vi.fn(async () => { await gate; return { cancel: async () => {} }; });
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: [], install: false, uninstall: false, start }] });
  const starting = service.start('owner', request);
  await vi.waitFor(() => expect(start).toHaveBeenCalled());
  const closing = service.close();
  try { await expect(service.capabilities('owner')).rejects.toThrow('unavailable'); }
  finally { release(); await starting; await closing; }
});
it('rejects secret submissions immediately instead of queuing behind another operation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = vi.fn(async () => { await gate; return { cancel: async () => {} }; });
  const verifyKey = vi.fn(async () => {});
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: ['openai'], install: false, uninstall: false, start, verifyKey }] });
  const starting = service.start('owner', request);
  await vi.waitFor(() => expect(start).toHaveBeenCalled());
  let settled = false;
  const saving = service.verifyKey('owner', { harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-synthetic-fixture' }).catch(error => { settled = true; return error; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    expect((await saving).message).toBe('unavailable');
    expect(verifyKey).not.toHaveBeenCalled();
  } finally { release(); await starting; await saving; await service.close(); }
});
it('projects only exact harness active operation identity for reopening Settings', async () => {
  const { service } = fixture();
  expect((await service.capabilities('owner'))[0]!.activeOperationId).toBeUndefined();
  const operation = await service.start('owner', request);
  expect((await service.capabilities('owner'))[0]!.activeOperationId).toBe(operation.id);
  await expect(service.capabilities('other')).rejects.toThrow();
  await service.cancel('owner', operation.id);
  expect((await service.capabilities('owner'))[0]!.activeOperationId).toBeUndefined();
});
