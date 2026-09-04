import { describe, expect, it, vi } from 'vitest';
import { readManagementResponse, runBackendManagement } from '../../scripts/release/manage-backend.mjs';
const policy = { revision: 1, activeVersion: null, config: { enabled: false, batchSize: 5, soakSeconds: 300, bootstrapVersion: null, canaryMachineIds: [], clients: {} } };
describe('managed backend operator automation', () => {
  it('bounds streamed inventory responses before buffering them', async () => {
    expect(await readManagementResponse(new Response('{"ok":true}'))).toEqual({ ok: true });
    await expect(readManagementResponse(new Response('x'.repeat(1_000_001)))).rejects.toThrow('too large');
  });
  it('defaults to read-only inventory and emits no customer identifiers', async () => {
    const request = vi.fn(async () => ({ policy, machines: [{ machineId: 'private-customer', status: 'pending' }], nextCursor: null }));
    const result = await runBackendManagement({ args: [], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private-customer');
  });
  it('requires a reviewed bridge and canary before enabling', async () => {
    const request = vi.fn(async () => ({ policy, machines: [], nextCursor: null }));
    await expect(runBackendManagement({ args: ['enable'], request })).rejects.toThrow();
    expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
  });
  it('writes a CAS policy preserving independently configured client minimums', async () => {
    const request = vi.fn(async () => ({ policy, machines: [], nextCursor: null }));
    await runBackendManagement({ args: ['enable', '--bridge', 'v2026.08.28-1', '--canary', 'machine_1'], request });
    expect(request).toHaveBeenLastCalledWith('/backend-management/policy', { method: 'PUT', body: expect.objectContaining({ revision: 1, config: expect.objectContaining({ enabled: true, bootstrapVersion: 'v2026.08.28-1', canaryMachineIds: ['machine_1'], clients: {} }) }) });
  });
  it('publishes latest desktop version without raising the minimum', async () => {
    const request = vi.fn(async () => ({ policy, machines: [], nextCursor: null }));
    await runBackendManagement({ args: ['publish-client', '--target', 'desktop-macos', '--latest', '2.0.0', '--download', 'https://github.com/HamedMP/matrix-os/releases/tag/desktop-stable'], request });
    expect(request).toHaveBeenLastCalledWith('/backend-management/policy', { method: 'PUT', body: expect.objectContaining({ config: expect.objectContaining({ clients: { 'desktop-macos': expect.objectContaining({ latestVersion: '2.0.0', minSupportedVersion: '0.0.0' }) } }) }) });
  });

});
