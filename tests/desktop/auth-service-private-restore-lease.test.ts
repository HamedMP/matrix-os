import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, type ConnectionProfile } from '@desktop/main/auth/auth-service';
import type { StoredCredential } from '@desktop/main/auth/credential-store';

const NOW = Date.parse('2026-10-17T07:00:00.000Z');
const EXPIRES = NOW + 5000;
const SLOT = 'pv-2545-1234abcd';
const HOST = 'https://app.matrix.test';
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(boundary: 'credential' | 'profile') {
  let now = NOW, flow = 0;
  let stored: StoredCredential | null = null;
  let profile: ConnectionProfile | null = { handle: SLOT, userId: 'owner', platformHost: HOST, runtimeSlot: SLOT };
  const entered = deferred(), gate = deferred();
  const save = vi.fn(async (next: StoredCredential) => {
    if (next.handle === SLOT && boundary === 'credential') { entered.resolve(); await gate.promise; }
    stored = next;
  });
  const saveProfile = vi.fn(async (next: ConnectionProfile) => {
    if (next.handle === SLOT && boundary === 'profile') { entered.resolve(); await gate.promise; }
    profile = next;
  });
  const clear = vi.fn(async () => { stored = null; });
  const clearProfile = vi.fn(async () => { profile = null; });
  const changes = vi.fn();
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/device/code')) {
      flow++;
      return Response.json({ deviceCode: `device-${flow}`, userCode: 'ABCD', verificationUri: `${HOST}/device`, expiresIn: 600, interval: 5 });
    }
    if (url.endsWith('/device/token')) return Response.json({ accessToken: `device-token-${flow}`, expiresAt: NOW + 3_600_000, userId: 'owner', handle: 'owner' });
    if (url.endsWith('/private-previews')) return Response.json({ privatePreviews: [{
      machineId: '00000000-0000-4000-8000-000000000001', handle: SLOT, pr: 2545,
      confirmedBundleVersion: null, status: 'running',
      provisionedAt: new Date(EXPIRES - 72 * 3_600_000).toISOString(), expiresAt: new Date(EXPIRES).toISOString(),
    }] });
    if (url.endsWith('/runtime-selection') && init?.body === JSON.stringify({ slot: SLOT })) {
      return Response.json({ accessToken: 'r'.repeat(64), expiresAt: NOW + 3_600_000, handle: SLOT, slot: SLOT });
    }
    throw new Error('unexpected synthetic request');
  });
  const auth = new AuthService({
    credentialStore: { load: async () => stored, save, clear },
    platformHost: HOST, runtimeSelectionOrigin: HOST, now: () => now, fetchFn,
    loadProfile: async () => profile, saveProfile, clearProfile, onAuthChanged: changes,
  });
  await auth.init();
  return { auth, fetchFn, entered, gate, save, saveProfile, clear, clearProfile, changes,
    expire: () => { now = EXPIRES; }, stored: () => stored, profile: () => profile };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('private device-flow restore lease across persistence', () => {
  it.each([
    ['credential', 'resolve'], ['profile', 'resolve'], ['credential', 'reject'], ['profile', 'reject'],
  ] as const)('withholds authority and clears expired %s persistence after %s', async (boundary, settlement) => {
    const f = await fixture(boundary);
    await f.auth.startDeviceFlow('sign-in'); await f.entered.promise;
    expect.soft(f.auth.getToken()).toBeNull();
    expect.soft(f.auth.getStatus().signedIn).toBe(false);
    f.expire();
    expect.soft(f.auth.getToken()).toBeNull();
    if (settlement === 'resolve') f.gate.resolve(); else f.gate.reject(new Error('synthetic save failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.auth.poll()).toEqual({ status: 'expired' });
    expect(f.auth.getStatus().signedIn).toBe(false);
    expect(f.auth.getToken()).toBeNull();
    expect(f.stored()).toBeNull(); expect(f.profile()).toBeNull();
    expect(f.clear).toHaveBeenCalledOnce(); expect(f.clearProfile).toHaveBeenCalledOnce();
    expect(f.changes).not.toHaveBeenCalledWith(expect.objectContaining({ signedIn: true }));
    expect(f.fetchFn.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/auth/device/code', '/api/auth/device/token', '/api/private-previews', '/api/auth/runtime-selection',
    ]);
    if (boundary === 'credential') expect(f.saveProfile).not.toHaveBeenCalled();
  });

  it.each(['credential', 'profile'] as const)('commits an unexpired restore only after %s persistence settles', async boundary => {
    const f = await fixture(boundary);
    await f.auth.startDeviceFlow('sign-in'); await f.entered.promise;
    expect.soft(f.auth.getToken()).toBeNull();
    expect(f.auth.poll().status).toBe('pending');
    f.gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.auth.getStatus()).toMatchObject({ signedIn: true, handle: SLOT, runtimeSlot: SLOT, authGeneration: 1 });
    expect(f.auth.getToken()).toBe('r'.repeat(64));
    expect(f.auth.poll()).toEqual({ status: 'authorized', profile: { handle: SLOT, userId: 'owner' } });
    expect(f.stored()?.handle).toBe(SLOT); expect(f.profile()?.runtimeSlot).toBe(SLOT);
    expect(f.changes).toHaveBeenCalledOnce(); expect(f.clear).not.toHaveBeenCalled();
  });

  it.each(['credential', 'profile'] as const)('does not let cancelled old %s persistence clear a newer sign-in', async boundary => {
    const f = await fixture(boundary);
    await f.auth.startDeviceFlow('sign-in'); await f.entered.promise;
    const signedOut = f.auth.signOut();
    await f.auth.startDeviceFlow('sign-in');
    await vi.advanceTimersByTimeAsync(0);
    f.expire(); f.gate.resolve();
    await signedOut; await vi.advanceTimersByTimeAsync(0);
    expect(f.auth.getStatus()).toMatchObject({ signedIn: true, handle: 'owner', runtimeSlot: 'primary' });
    expect(f.auth.getToken()).toBe('device-token-2');
    expect(f.auth.poll().status).toBe('authorized');
    expect(f.stored()?.accessToken).toBe('device-token-2'); expect(f.profile()?.runtimeSlot).toBe('primary');
    expect(f.changes.mock.calls.filter(([status]) => status.signedIn)).toHaveLength(1);
  });
});
