import { describe, expect, it, vi } from 'vitest';
import { createPublicBrowserContextRuntime } from '../../packages/gateway/src/shared-browser/public-context-runtime.js';

const contextId = 'public-context';
function setup(result: Record<string, unknown> = { browserContextId: contextId }) {
  const requests: Array<[string, Record<string, unknown> | undefined]> = [];
  const owner = {
    available: true,
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => { requests.push([method, params]); return result; }),
    close: vi.fn(async () => { owner.available = false; }),
  };
  const proxy = { port: 12345, close: vi.fn(async () => {}) };
  const startEgress = vi.fn(async () => proxy);
  const connectOwner = vi.fn(async () => owner);
  return { requests, owner, proxy, startEgress, connectOwner };
}

describe('public Browser context lifetime', () => {
  it('creates one fail-closed proxy-bound context and closes its independent owner transport on runtime shutdown', async () => {
    const s = setup();
    const runtime = createPublicBrowserContextRuntime(s);
    try {
      expect(await Promise.all([runtime.create(), runtime.create()])).toEqual([contextId, contextId]);
      expect(await runtime.create()).toBe(contextId);
      expect(s.startEgress).toHaveBeenCalledOnce();
      expect(s.connectOwner).toHaveBeenCalledOnce();
      expect(s.requests).toEqual([['Target.createBrowserContext', {
        disposeOnDetach: true, proxyServer: 'http://127.0.0.1:12345', proxyBypassList: '<-loopback>',
      }], ['Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: contextId, eventsEnabled: false }]]);
      expect(s.owner.close).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
    expect(s.owner.close).toHaveBeenCalledOnce();
    expect(s.proxy.close).toHaveBeenCalledOnce();
    await expect(runtime.create()).rejects.toMatchObject({ code: 'browser_unavailable' });
  });

  it('closes both resources when Chrome cannot acknowledge context identity', async () => {
    const s = setup({});
    const runtime = createPublicBrowserContextRuntime(s);
    try {
      await expect(runtime.create()).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(s.owner.close).toHaveBeenCalledOnce();
      expect(s.proxy.close).toHaveBeenCalledOnce();
    } finally { await runtime.close(); }
  });

  it('replaces only the context that the action transport confirmed absent', async () => {
    const previous = setup();
    const replacementId = 'replacement-context';
    const replacement = setup({ browserContextId: replacementId });
    const connectOwner = vi.fn().mockResolvedValueOnce(previous.owner).mockResolvedValueOnce(replacement.owner);
    const startEgress = vi.fn().mockResolvedValueOnce(previous.proxy).mockResolvedValueOnce(replacement.proxy);
    const runtime = createPublicBrowserContextRuntime({ connectOwner, startEgress });
    try {
      await expect(runtime.create()).resolves.toBe(contextId);
      await expect(runtime.create('different-context')).resolves.toBe(contextId);
      await expect(Promise.all([runtime.create(contextId), runtime.create()])).resolves.toEqual([replacementId, replacementId]);
      await expect(runtime.create(contextId)).resolves.toBe(replacementId);
      expect(previous.owner.close).toHaveBeenCalledOnce();
      expect(previous.proxy.close).toHaveBeenCalledOnce();
      expect(connectOwner).toHaveBeenCalledTimes(2);
      expect(startEgress).toHaveBeenCalledTimes(2);
    } finally { await runtime.close(); }
    expect(replacement.owner.close).toHaveBeenCalledOnce();
    expect(replacement.proxy.close).toHaveBeenCalledOnce();
  });
});
