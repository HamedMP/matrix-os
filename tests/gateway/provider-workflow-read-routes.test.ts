import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderWorkflowRoutes } from '../../packages/gateway/src/ai-providers/provider-workflow-routes.js';
import { createProviderWorkflowService } from '../../packages/gateway/src/ai-providers/provider-workflows.js';

const cases = [
  { path: '/v2/op_missing', invalid: '/v2/!bad', status: 404 },
  { path: '/op_missing', invalid: '/!bad', status: 404 },
  { path: '/logs/pi', invalid: '/logs/!bad', status: 200 },
  { path: '/capabilities', invalid: '/capabilities?connectionVersion=3', status: 200 },
];
afterEach(() => vi.restoreAllMocks());
describe('workflow read handlers preserve async and immediate-response boundaries', () => {
  it.each(cases)('preserves validation, authentication and awaited results for $path', async ({ path, invalid, status }) => {
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'pi', harness: 'pi', displayName: 'Pi', installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: [], install: false, uninstall: false, start: async () => ({ cancel: async () => {} }) }] });
    try {
      const app = createProviderWorkflowRoutes({ service, getPrincipal: () => ({ userId: 'owner' }) });
      const invalidResponse = await app.request(`/provider-settings/workflows${invalid}`);
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toEqual({ error: { code: 'invalid_request', message: 'Invalid request.' } });
      const denied = createProviderWorkflowRoutes({ service, getPrincipal: () => null });
      expect((await denied.request(`/provider-settings/workflows${path}`)).status).toBe(401);
      const other = createProviderWorkflowRoutes({ service, getPrincipal: () => ({ userId: 'other' }) });
      expect((await other.request(`/provider-settings/workflows${path}`)).status).toBe(403);
      const response = await app.request(`/provider-settings/workflows${path}`);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      if (status === 404) expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      else if (path.startsWith('/logs')) expect(await response.json()).toEqual({ entries: [] });
      else expect(await response.json()).toMatchObject([{ harnessInstanceId: 'pi' }]);
    } finally { await service.close(); }
  });

  it.each(cases)('normalizes unexpected failures without exposing details for $path', async ({ path }) => {
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = createProviderWorkflowRoutes({ service, getPrincipal: () => { throw new Error('private credential path'); } });
      const response = await app.request(`/provider-settings/workflows${path}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'unavailable', message: 'This operation is unavailable. Refresh and try again.' } });
      expect(warn).toHaveBeenCalledWith('[provider-workflow] Request failed:', 'Error');
    } finally { await service.close(); }
  });
});
