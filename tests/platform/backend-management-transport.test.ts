import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedBackendTransport } from '../../packages/platform/src/backend-management-transport';
const machine = { machineId: 'machine_1', handle: 'person', publicIPv4: '95.216.1.2' };
describe('legacy backend bridge transport', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses existing update contract, immutable target, token, timeout and no redirects', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    const transport = createManagedBackendTransport({ platformSecret: 'secret', fetchFn });
    await transport.deploy(machine, 'v2026.08.28-1');
    expect(fetchFn).toHaveBeenCalledWith('https://95.216.1.2:443/api/system/update', expect.objectContaining({ method: 'POST', body: JSON.stringify({ version: 'v2026.08.28-1' }), redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it('rejects unsafe addresses, invalid versions and absent credentials before network calls', async () => {
    const fetchFn = vi.fn(); const transport = createManagedBackendTransport({ platformSecret: 'secret', fetchFn });
    for (const ip of [null, '', '0.0.0.1', '224.0.0.1', '100.64.0.1', '172.16.0.1', '192.168.0.1', '192.88.99.1', '198.18.0.1', '198.19.0.1', '198.51.100.1', '203.0.113.1', '127.0.0.1', '169.254.169.254', '10.0.0.1', '192.0.2.1', 'evil.example', '95.216.1.2@evil.example']) {
      await expect(transport.probe({ ...machine, publicIPv4: ip })).rejects.toThrow();
    }
    await expect(transport.deploy(machine, ';bad')).rejects.toThrow();
    await expect(createManagedBackendTransport({ platformSecret: '', fetchFn }).probe(machine)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('reads installed release provenance, not provisioning metadata', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '0.9.0', release: { version: 'v2026.08.28-1' } })));
    expect(await createManagedBackendTransport({ platformSecret: 'secret', fetchFn }).probe(machine)).toEqual({ version: 'v2026.08.28-1', healthy: true });
  });
  it('requires the bridge host services to be active before accepting its health', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ version: 'v2026.08.28-1', managedUpdates: true, managedServiceHealth: { shell: false, syncAgent: true } })));
    const transport = createManagedBackendTransport({ platformSecret: 'secret', fetchFn });
    expect((await transport.probe(machine)).healthy).toBe(false);
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ version: 'v2026.08.28-1', managedUpdates: true })));
    expect((await transport.probe(machine)).healthy).toBe(false);
  });
  it('handles busy runtimes, failed probes and bounded or malformed responses', async () => {
    const fetchFn = vi.fn();
    const transport = createManagedBackendTransport({ platformSecret: 'secret', fetchFn });
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'runtime_busy' }), { status: 409 }));
    await expect(transport.deploy(machine, 'v2026.08.28-1')).rejects.toBeInstanceOf((await import('../../packages/platform/src/backend-management-transport')).ManagedRuntimeBusy);
    fetchFn.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    expect(await transport.probe(machine)).toEqual({ healthy: false, version: null });
    fetchFn.mockResolvedValueOnce(new Response('x'.repeat(65_537)));
    await expect(transport.probe(machine)).rejects.toThrow('too large');
    fetchFn.mockResolvedValueOnce(new Response(null));
    await expect(transport.probe(machine)).rejects.toThrow('Missing');
    fetchFn.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(transport.deploy(machine, 'v2026.08.28-1')).rejects.toThrow('dispatch');
    fetchFn.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await expect(transport.deploy(machine, 'v2026.08.28-1')).rejects.toThrow('dispatch');
  });
  it('uses the configured TLS dispatcher and checks all bridge service health flags', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchFn);
    const dispatcher = {} as never;
    const transport = createManagedBackendTransport({ platformSecret: 'secret', dispatcher });
    expect(await transport.probe(machine)).toEqual({ healthy: true, version: null });
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dispatcher }));
    for (const syncAgent of [false, true]) {
      fetchFn.mockImplementation(async () => new Response(JSON.stringify({ managedUpdates: true, managedServiceHealth: { shell: true, syncAgent } })));
      expect((await transport.probe(machine)).healthy).toBe(syncAgent);
    }
  });
});
