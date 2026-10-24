// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken, userId: 'owner' }) }));
const getToken = vi.hoisted(() => vi.fn(async () => 'owner-token'));
import { useJourney } from '../../shell/src/hooks/useJourney';
const state = { phase: 'payment_settling', detail: 'Activating your subscription…', nextAction: { kind: 'wait' } };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('journey checkout reconciliation', () => {
  it('verifies the owner/slot before the initial journey and again on explicit refresh', async () => {
    const fetchMock = vi.fn(async (url: string) => response(url.includes('/reconcile') ? { status: 'complete' } : state));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useJourney({ reconcileCheckout: true, runtimeSlot: 'studio' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['/billing/checkout/reconcile', '/api/journey?runtimeSlot=studio']);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/billing/checkout/reconcile', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ runtimeSlot: 'studio' }),
      headers: expect.objectContaining({ Authorization: 'Bearer owner-token' }), signal: expect.any(AbortSignal),
    }));
    act(() => result.current.refreshJourney());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2][0]).toBe('/billing/checkout/reconcile');
  });
  it('keeps automatic polling local after verification succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => response(url.includes('/reconcile') ? { status: 'complete' } : state));
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useJourney({ reconcileCheckout: true }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(fetchMock.mock.calls.filter(c => c[0].includes('/reconcile'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/journey')).toHaveLength(4);
  });
  it('does not route to plans after ambiguous verification, caps retries, and allows manual retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string) => response({ error: 'Billing unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useJourney({ reconcileCheckout: true }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current.status).toBe('unreachable');
    expect(result.current.state).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(c => c[0] === '/billing/checkout/reconcile')).toBe(true);
    act(() => result.current.refreshJourney());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('stops on authentication expiry instead of reading the journey', async () => {
    const fetchMock = vi.fn(async () => response({}, 401));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useJourney({ reconcileCheckout: true }));
    await waitFor(() => expect(result.current.status).toBe('unauthorized'));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/billing/checkout/reconcile', expect.anything());
  });
  it('does not reconcile for other journey consumers that have not opted in', async () => {
    const fetchMock = vi.fn(async () => response(state));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useJourney());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/journey', expect.anything());
  });
});
