import { describe, expect, it, vi } from 'vitest';
import {
  createR2CapabilityGate,
  createStorageGatedHetznerClient,
} from '../../packages/platform/src/r2-capability.js';
import { createMockHetznerClient } from './customer-vps-fixtures.js';

function createStorage() {
  let exists = false;
  return {
    headObject: vi.fn(async () => ({ exists, etag: exists ? 'canary-etag' : undefined })),
    putObject: vi.fn(async () => {
      exists = true;
      return { etag: 'canary-etag' };
    }),
    deleteObject: vi.fn(async () => {
      exists = false;
    }),
  };
}

describe('primary R2 capability gate', () => {
  it('requires absence, put, head, delete, and final absence in order', async () => {
    const storage = createStorage();
    const gate = createR2CapabilityGate({
      storage,
      keyFactory: () => '_platform/canary/123',
    });

    await expect(gate.assertReady({ force: true })).resolves.toBeUndefined();

    expect(storage.headObject).toHaveBeenNthCalledWith(
      1,
      '_platform/canary/123',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.headObject).toHaveBeenCalledTimes(3);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject.mock.invocationCallOrder[0])
      .toBeLessThan(storage.headObject.mock.invocationCallOrder[2]);
  });

  it('attempts final absence verification after deletion fails and rejects the probe', async () => {
    const storage = createStorage();
    storage.deleteObject.mockRejectedValueOnce(new Error('delete denied'));
    const gate = createR2CapabilityGate({
      storage,
      keyFactory: () => '_platform/canary/456',
    });

    await expect(gate.assertReady({ force: true })).rejects.toThrow('Primary storage unavailable');
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.headObject).toHaveBeenCalledTimes(3);
  });

  it('keeps one successful result for thirty seconds and never caches failures', async () => {
    let now = 1_000;
    const storage = createStorage();
    const gate = createR2CapabilityGate({
      storage,
      now: () => now,
      keyFactory: () => `_platform/canary/${now}`,
    });

    await gate.assertReady();
    await gate.assertReady();
    expect(storage.putObject).toHaveBeenCalledTimes(1);

    now += 30_001;
    await gate.assertReady();
    expect(storage.putObject).toHaveBeenCalledTimes(2);

    storage.putObject.mockRejectedValueOnce(new Error('write denied'));
    now += 30_001;
    await expect(gate.assertReady()).rejects.toThrow('Primary storage unavailable');
    await expect(gate.assertReady()).resolves.toBeUndefined();
    expect(storage.putObject).toHaveBeenCalledTimes(4);
  });

  it('guards the centralized Hetzner createServer call before provider mutation', async () => {
    const order: string[] = [];
    const base = createMockHetznerClient({
      createServer: vi.fn(async () => {
        order.push('create');
        return {
          id: 123,
          status: 'running',
          serverType: 'cpx22',
          publicIPv4: '203.0.113.10',
          publicIPv6: null,
        };
      }),
    });
    const guarded = createStorageGatedHetznerClient(base, async () => {
      order.push('storage');
    });

    await guarded.createServer({
      name: 'test',
      serverType: 'cpx22',
      location: 'nbg1',
      userData: '#cloud-config',
      labels: { app: 'matrix-os' },
    });

    expect(order).toEqual(['storage', 'create']);
  });
});
