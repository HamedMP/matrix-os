import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import type { CustomerVpsObjectStore } from '../../packages/platform/src/customer-vps-r2.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';

function streamText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe('platform host bundle route', () => {
  const orchestrator = {
    provision: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    rollingRestart: vi.fn(),
    getInfo: vi.fn(),
    getImage: vi.fn(),
    listAll: vi.fn().mockReturnValue([]),
    syncStates: vi.fn(),
  } as unknown as Orchestrator;

  it('serves host bundles from private object storage without admin auth', async () => {
    const getObject = vi.fn().mockResolvedValue({
      body: streamText('sha  matrix-host-bundle.tar.gz\n'),
      etag: '"etag"',
      contentLength: 34,
    });
    const app = createApp({
      db: {} as PlatformDB,
      orchestrator,
      customerVpsObjectStore: {
        getObject,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz.sha256');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('sha  matrix-host-bundle.tar.gz\n');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(getObject).toHaveBeenCalledWith(
      'system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz.sha256',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects invalid host bundle keys', async () => {
    const getObject = vi.fn();
    const app = createApp({
      db: {} as PlatformDB,
      orchestrator,
      customerVpsObjectStore: {
        getObject,
        putObject: vi.fn(),
      } as unknown as CustomerVpsObjectStore,
    });

    const res = await app.request('/system-bundles/matrix-os-host-dev/evil.tgz');

    expect(res.status).toBe(400);
    expect(getObject).not.toHaveBeenCalled();
  });
});
