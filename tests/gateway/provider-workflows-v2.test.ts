import { describe, expect, it, vi } from 'vitest';
import { ProviderWorkflowCapabilitiesSchema, ProviderWorkflowSchema } from '@matrix-os/contracts';
import { createProviderWorkflowService, type ProviderWorkflowAdapter } from '../../packages/gateway/src/ai-providers/provider-workflows.js';
import { createProviderWorkflowRoutes } from '../../packages/gateway/src/ai-providers/provider-workflow-routes.js';

const login = { id: 'openai_device', providerId: 'openai' as const, authKind: 'subscription' as const, method: 'device_code' as const, billingKind: 'subscription' as const, executionKind: 'native' as const, availability: 'available' as const };
const key = { id: 'anthropic_key', providerId: 'anthropic' as const, authKind: 'api_key' as const, billingKind: 'api_key' as const, executionKind: 'native' as const, availability: 'available' as const };
const request = { harnessInstanceId: 'pi', optionId: login.id, idempotencyKey: 'v2-attempt' };
function fixture() {
  const cancel = vi.fn(async () => {});
  const start = vi.fn<ProviderWorkflowAdapter['start']>(async () => ({ cancel }));
  const verifyKey = vi.fn(async () => {});
  const adapter: ProviderWorkflowAdapter = { harnessInstanceId: 'pi', harness: 'pi', displayName: 'Pi', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: ['anthropic'], install: false, uninstall: false, connectionOptions: [login, key], start, verifyKey };
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: () => Promise.resolve([adapter]) });
  return { service, adapter, start, verifyKey, cancel, app: createProviderWorkflowRoutes({ service, getPrincipal: c => ({ userId: c.req.header('owner') ?? 'owner' }) }) };
}
describe('provider-qualified admission', () => {
  it('resolves exact option and freezes receipt identity, preserving V1 compatibility', async () => {
    const { service, start, adapter } = fixture();
    const op = await service.startV2('owner', request);
    expect(start.mock.calls[0]![0]).toMatchObject({ request: { kind: 'login', method: 'device_code' }, connectionOption: login });
    expect(op.connectionOption).toEqual(login);
    adapter.connectionOptions = [key];
    expect(await service.startV2('owner', request)).toEqual(op);
    expect((await service.statusV2('owner', op.id)).connectionOption).toEqual(login);
    expect(ProviderWorkflowSchema.safeParse(await service.status('owner', op.id)).success).toBe(true);
    expect(ProviderWorkflowCapabilitiesSchema.safeParse(await service.capabilities('owner')).success).toBe(true);
    await service.close();
  });
  it('rejects unavailable, key-as-login, missing and cross-owner options before adapters', async () => {
    const { service, adapter, start } = fixture();
    adapter.connectionOptions!.push({ ...login, id: 'gated', availability: 'unavailable', unavailableReason: 'provider_access_required' });
    for (const optionId of ['gated', key.id, 'missing']) await expect(service.startV2('owner', { ...request, optionId })).rejects.toThrow('unavailable');
    await expect(service.startV2('other', request)).rejects.toThrow('forbidden');
    expect(start).not.toHaveBeenCalled();
  });
  it('maps an API key to the selected fixed provider and shares native admission', async () => {
    const { service, verifyKey } = fixture();
    expect(await service.verifyKeyV2('owner', { harnessInstanceId: 'pi', optionId: key.id, apiKey: 'sk-synthetic' })).toEqual({ verified: true });
    expect(verifyKey).toHaveBeenCalledWith({ harnessInstanceId: 'pi', providerId: 'anthropic', apiKey: 'sk-synthetic' });
    const op = await service.startV2('owner', request);
    await expect(service.verifyKeyV2('owner', { harnessInstanceId: 'pi', optionId: key.id, apiKey: 'sk-synthetic' })).rejects.toThrow('conflict');
    await service.cancel('owner', op.id);
    await expect(service.start('owner', { harnessInstanceId: 'pi', kind: 'login', method: 'device_code', idempotencyKey: request.idempotencyKey })).rejects.toThrow('conflict');
    await service.close();
  });
  it('rejects dishonest registration rather than projecting unsupported executable options', async () => {
    const { service, adapter } = fixture();
    adapter.connectionOptions = [login, login];
    await expect(service.capabilitiesV2('owner')).rejects.toThrow();
    adapter.connectionOptions = [key]; adapter.verifyKey = undefined;
    await expect(service.capabilitiesV2('owner')).rejects.toThrow();
  });
  it('retains admitted identity through failed replacement and cleanup', async () => {
    const { service, start, cancel } = fixture();
    start.mockImplementationOnce(async ({ registerCleanup, publish }) => { registerCleanup(cancel); publish({ deviceCode: 'ABCD-EFGH', authorizationUrl: 'https://auth.openai.com/codex/device' }); throw new Error('synthetic'); });
    const op = await service.startV2('owner', request);
    expect(op).toMatchObject({ state: 'failed', deviceCode: null, authorizationUrl: null, connectionOption: login });
    expect(cancel).toHaveBeenCalledOnce();
    await service.close();
  });
  it('binds one-use code submission and preserves completion winning cancellation', async () => {
    const { service, start } = fixture();
    const submitCode = vi.fn(async () => {});
    start.mockImplementationOnce(async ({ publish }) => ({ submitCode, cancel: async () => { publish({ state: 'succeeded' }); } }));
    const op = await service.startV2('owner', request);
    await expect(service.submitCode('other', op.id, 'synthetic-code')).rejects.toThrow('forbidden');
    expect(await service.submitCode('owner', op.id, 'synthetic-code')).toEqual({ accepted: true });
    await expect(service.submitCode('owner', op.id, 'second-code')).rejects.toThrow('conflict');
    expect(submitCode).toHaveBeenCalledExactlyOnceWith('synthetic-code');
    expect(await service.cancelV2('owner', op.id)).toMatchObject({ state: 'succeeded', connectionOption: login });
    await service.close();
  });
  it('cannot mutate admitted descriptors through returned receipt objects', async () => {
    const { service } = fixture();
    const op = await service.startV2('owner', request);
    op.connectionOption!.providerId = 'anthropic';
    expect((await service.statusV2('owner', op.id)).connectionOption!.providerId).toBe('openai');
    await service.close();
  });
});
describe('V2 HTTP boundaries', () => {
  it('authenticates all new routes, preserves private reads and validates before side effects', async () => {
    const { app, service, start, verifyKey } = fixture();
    const response = await app.request('/provider-settings/workflows/v2/capabilities');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject([{ connectionOptions: [login, key] }]);
    expect((await app.request('/provider-settings/workflows/v2/capabilities', { headers: { owner: 'other' } })).status).toBe(403);
    const denied = createProviderWorkflowRoutes({ service, getPrincipal: () => null });
    expect((await denied.request('/provider-settings/workflows/v2/capabilities')).status).toBe(401);
    expect((await app.request('/provider-settings/workflows/v2/start', { method: 'POST', body: JSON.stringify({ ...request, providerId: 'anthropic' }) })).status).toBe(400);
    expect((await app.request('/provider-settings/workflows/v2/keys', { method: 'POST', body: 'x'.repeat(9000) })).status).toBe(413);
    expect(start).not.toHaveBeenCalled(); expect(verifyKey).not.toHaveBeenCalled();
  });
  it('starts and cancels via V2 while historical reads retain their exact shape', async () => {
    const { app, service } = fixture();
    const op = await (await app.request('/provider-settings/workflows/v2/start', { method: 'POST', body: JSON.stringify(request) })).json();
    expect(op.connectionOption).toEqual(login);
    expect((await app.request(`/provider-settings/workflows/v2/${op.id}`)).status).toBe(200);
    const cancelled = await (await app.request(`/provider-settings/workflows/v2/${op.id}/cancel`, { method: 'POST', body: '{}' })).json();
    expect(cancelled).toMatchObject({ state: 'cancelled', connectionOption: login });
    const old = await (await app.request(`/provider-settings/workflows/${op.id}`)).json();
    expect(ProviderWorkflowSchema.safeParse(old).success).toBe(true); expect(old.connectionOption).toBeUndefined();
    await service.close();
  });
  it('recovers historical operations through V2 without inventing a provider', async () => {
    const { app, service } = fixture();
    const op = await service.start('owner', { harnessInstanceId: 'pi', kind: 'login', method: 'device_code', idempotencyKey: 'legacy' });
    expect(await (await app.request(`/provider-settings/workflows/v2/${op.id}`)).json()).toMatchObject({ id: op.id, connectionOption: null });
    await service.close();
  });
});
