// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMatrixBillingAccessCacheForTests, useMatrixBillingAccess } from '../../shell/src/hooks/useMatrixBillingAccess';
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: 'owner', has: () => false }) }));
const management = { subscription: null, portalAvailable: true, computerCount: 0, runtimeSlot: 'primary', runtimePlacement: null };
beforeEach(() => { resetMatrixBillingAccessCacheForTests(); window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('billing management hook', () => {
  it('preserves account management even with no effective runtime entitlement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      entitlement: null, access: { runtimeProxyAllowed: false, reason: 'no_entitlement' }, management,
    })));
    const { result } = renderHook(() => useMatrixBillingAccess());
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.management).toEqual(management);
    expect(fetchMock).toHaveBeenCalledWith('/billing/status?details=management', expect.objectContaining({ credentials: 'include' }));
  });
  it('requests the selected runtime instead of silently showing primary billing', async () => {
    window.history.replaceState({}, '', '/vm/example?runtime=studio');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      entitlement: null, access: { runtimeProxyAllowed: false, reason: 'no_entitlement' },
      management: { ...management, runtimeSlot: 'studio' },
    })));
    const { result } = renderHook(() => useMatrixBillingAccess());
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/billing/status?details=management&runtimeSlot=studio', expect.any(Object));
  });

});
