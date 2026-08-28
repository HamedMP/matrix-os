import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedUpdatePolicy } from '../../packages/gateway/src/managed-update-policy';
const env = { MATRIX_MACHINE_ID: 'machine_1', PLATFORM_INTERNAL_URL: 'https://app.matrix-os.com', UPGRADE_TOKEN: 'operator-token' };
describe('managed runtime version selection', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps self-hosted control and denies managed user changes by default', async () => {
    expect(await createManagedUpdatePolicy({ env: {} }).canSelect()).toBe(true);
    expect(await createManagedUpdatePolicy({ env }).canSelect('Bearer operator-token')).toBe(true);
    expect(await createManagedUpdatePolicy({ env, fetchFn: vi.fn().mockRejectedValue(new Error('offline')) }).canSelect('Bearer customer')).toBe(false);
  });
  it('allows only active server-side support overrides, never a client flag', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ managed: true, versionSelectionAllowed: true, holdUntil: new Date(Date.now() + 60_000).toISOString() })));
    expect(await createManagedUpdatePolicy({ env, fetchFn }).canSelect('Bearer customer')).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('https://app.matrix-os.com/backend-management/machines/machine_1/policy', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it('does not mistake a customer proxy credential for an operator action', async () => {
    const policy = createManagedUpdatePolicy({ env, fetchFn: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(await policy.canSelect('Bearer operator-token', '1')).toBe(false);
  });
  it('deduplicates policy reads and expires a cached support grant on time', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ managed: true, versionSelectionAllowed: true, holdUntil: new Date(Date.now() + 1000).toISOString() })))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const policy = createManagedUpdatePolicy({ env, fetchFn });
    expect(await Promise.all([policy.selectionAllowed(), policy.selectionAllowed()])).toEqual([true, true]);
    expect(await policy.selectionAllowed()).toBe(true); expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    expect(await policy.selectionAllowed()).toBe(false);
  });
  it('fails closed on missing configuration, missing bodies and oversized policy responses', async () => {
    const fetchFn = vi.fn();
    expect(await createManagedUpdatePolicy({ env: { MATRIX_MACHINE_ID: 'machine_1' }, fetchFn }).selectionAllowed()).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    fetchFn.mockResolvedValueOnce(new Response(null));
    expect(await createManagedUpdatePolicy({ env, fetchFn }).selectionAllowed()).toBe(false);
    fetchFn.mockResolvedValueOnce(new Response('x'.repeat(4097)));
    expect(await createManagedUpdatePolicy({ env, fetchFn }).selectionAllowed()).toBe(false);
    expect(await createManagedUpdatePolicy({ env: {} }).selectionAllowed()).toBe(true);
  });

});
