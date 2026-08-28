import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientPolicyReader } from '../../packages/contracts/src/client-policy-reader';
const response = { schemaVersion: 1, revision: 3, policy: { latestVersion: '2.0.0', minSupportedVersion: '1.5.0', downloadUrl: 'https://matrix-os.com/download', enforceAfter: '2026-01-01T00:00:00.000Z' } };
describe('client policy reader', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('supports native runtimes without streaming responses and ignores corrupt saved policy', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(response) }) as Response);
    const reader = createClientPolicyReader({ target: 'mobile-ios', fetchFn, load: async () => { throw new SyntaxError('corrupt saved data'); } });
    expect(await reader.read('https://app.matrix-os.com')).toEqual(response);
  });
  it('bounds a stalled request on native runtimes without AbortSignal.timeout', async () => {
    vi.useFakeTimers(); vi.stubGlobal('AbortSignal', {});
    const fetchFn = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const reader = createClientPolicyReader({ target: 'mobile-ios', fetchFn });
    const pending = reader.read('https://app.matrix-os.com');
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).policy).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains validated requirements on transient errors and isolates origins', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response))).mockRejectedValue(new Error('offline'));
    const reader = createClientPolicyReader({ target: 'desktop-macos', fetchFn });
    expect((await reader.read('https://app.matrix-os.com')).policy).toEqual(response.policy);
    expect((await reader.read('https://app.matrix-os.com')).policy).toEqual(response.policy);
    expect((await reader.read('https://self-hosted.example')).policy).toBeNull();
  });
  it('accepts a policy removal and rejects malformed responses without losing cached state', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, policy: { ...response.policy, downloadUrl: 'https://evil.example' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, revision: 4, policy: null })));
    const reader = createClientPolicyReader({ target: 'mobile-ios', fetchFn });
    await reader.read('https://app.matrix-os.com');
    expect((await reader.read('https://app.matrix-os.com')).revision).toBe(3);
    expect((await reader.read('https://app.matrix-os.com')).policy).toBeNull();
  });
  it('loads persisted requirements, deduplicates requests and ignores older revisions', async () => {
    const load = vi.fn(async () => ({ origin: 'https://app.matrix-os.com', response }));
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 1, revision: 1, policy: null })));
    const save = vi.fn();
    const reader = createClientPolicyReader({ target: 'desktop-macos', fetchFn, load, save });
    const [first, second] = await Promise.all([reader.read('https://app.matrix-os.com'), reader.read('https://app.matrix-os.com')]);
    expect(first).toEqual(response); expect(second).toEqual(response);
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled();
  });
  it('rejects oversized responses and retains a validated policy if persistence fails', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(new Response('x'.repeat(9000)));
    const reader = createClientPolicyReader({ target: 'desktop-macos', fetchFn, save: async () => { throw new Error('storage unavailable'); } });
    expect(await reader.read('https://app.matrix-os.com')).toEqual(response);
    expect(await reader.read('https://app.matrix-os.com')).toEqual(response);
  });
  it('does not let a late response from an old gateway evict the active gateway policy', async () => {
    let finishOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve; });
    const fetchFn = vi.fn().mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(response))).mockRejectedValue(new Error('offline'));
    const reader = createClientPolicyReader({ target: 'desktop-macos', fetchFn });
    const old = reader.read('https://old.example');
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await reader.read('https://app.matrix-os.com');
    finishOld(new Response(JSON.stringify({ ...response, revision: 99, policy: null }))); await old;
    expect(await reader.read('https://app.matrix-os.com')).toEqual(response);
  });
});
