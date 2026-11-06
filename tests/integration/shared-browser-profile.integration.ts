import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SharedBrowserAction, SharedBrowserActionResult } from '@matrix-os/contracts';
import { createSharedBrowserBroker } from '../../packages/gateway/src/shared-browser/broker.js';
import { createSharedBrowserCdpDriver } from '../../packages/gateway/src/shared-browser/cdp-driver.js';
import { PROFILE_HOST, startOwnedProfileChrome, startProfileFixture, type ProfileState } from '../helpers/shared-browser-profile.js';

type Chrome = Awaited<ReturnType<typeof startOwnedProfileChrome>>;
function actor(chrome: Chrome, homePath: string) {
  const driver = createSharedBrowserCdpDriver({ homePath, ...chrome.options,
    resolveHost: async hostname => {
      if (hostname !== PROFILE_HOST) throw new Error('Non-fixture host rejected');
      return [{ address: '1.1.1.1', family: 4 }]; // Test seam only; Chrome's exact hostname is mapped to its loopback fixture.
    },
  });
  const broker = createSharedBrowserBroker({ ownerId: 'fixture-owner', driver, setHumanControl: async () => {} });
  const binding = { ownerId: 'fixture-owner', chatId: 'fixture-chat', runId: randomUUID(), harness: 'pi' as const };
  const signal = AbortSignal.timeout(30_000);
  const run = broker.openRun(binding, signal);
  return { token: run.token, binding, broker, action: (action: SharedBrowserAction) => broker.execute(binding, action, signal), close: () => broker.close() };
}
type Actor = ReturnType<typeof actor>;
async function observe(current: Actor): Promise<{ result: SharedBrowserActionResult; state: ProfileState }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const result = await current.action({ action: 'snapshot' });
      const state = result.content?.match(/\{"authenticated":.*?\}/)?.[0];
      if (result.success && state) return { result, state: JSON.parse(state) as ProfileState };
    } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'observe_again') throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Fixture state did not become observable');
}
async function navigate(current: Actor, url: string) {
  expect((await current.action({ action: 'navigate', url })).success).toBe(true);
  return observe(current);
}
async function click(current: Actor, name: string) {
  const { result } = await observe(current);
  const element = result.elements?.find(row => row.name === name);
  expect(element, `observed ${name}`).toBeDefined();
  expect((await current.action({ action: 'click', observationId: result.observationId!, ref: element!.ref })).success).toBe(true);
}

describe('shared Chrome synthetic authentication profile', () => {
  it('reuses server authentication and persistent origin storage without restoring run authority or replaying an action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-shared-profile-'));
    const profile = join(root, 'owner-profile');
    const fixture = await startProfileFixture().catch(async error => { await rm(root, { recursive: true, force: true }); throw error; });
    let chrome: Chrome | undefined, current: Actor | undefined;
    try {
      chrome = await startOwnedProfileChrome(profile, fixture.proxy);
      console.info('[shared-profile] Executable:', chrome.executable, 'Version:', chrome.version);
      current = actor(chrome, root);
      const empty = await navigate(current, fixture.origin);
      expect(empty.state).toEqual({ authenticated: false, local: false, indexed: false, tab: false, cookieReadable: false, effects: 0 });
      await current.close(); current = undefined;

      // Explicit credential-free owner setup, separate from the agent's tools.
      await chrome.ownerGrant(fixture.origin);
      current = actor(chrome, root);
      const granted = await navigate(current, fixture.origin);
      expect(granted.state).toEqual({ authenticated: true, local: true, indexed: true, tab: false, cookieReadable: false, effects: 0 });
      expect(fixture.stats().authenticatedReads).toBeGreaterThan(0);
      await click(current, 'Record one action');
      await expect.poll(() => fixture.stats().effects).toBe(1);
      const retired = { token: current.token, binding: current.binding, observation: granted.result.observationId! };
      chrome.disconnect(); // Drop only this owned browser's CDP clients after an acknowledged effect.
      await current.close(); current = undefined;

      current = actor(chrome, root);
      expect(current.broker.resolveCapability(retired.token)).toBeNull();
      await expect(current.broker.execute(retired.binding, { action: 'snapshot' }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'run_unavailable' });
      const reattached = await navigate(current, fixture.origin);
      expect(reattached.state).toEqual({ authenticated: true, local: true, indexed: true, tab: false, cookieReadable: false, effects: 1 });
      await expect(current.action({ action: 'click', observationId: retired.observation, ref: 'r1' })).rejects.toMatchObject({ code: 'observe_again' });
      expect(fixture.stats().effects).toBe(1);
      await current.close(); current = undefined;
      await chrome.close(); chrome = undefined;

      chrome = await startOwnedProfileChrome(profile, fixture.proxy);
      current = actor(chrome, root);
      const restarted = await navigate(current, fixture.origin);
      expect(restarted.state).toEqual({ authenticated: true, local: true, indexed: true, tab: false, cookieReadable: false, effects: 1 });
      expect(fixture.stats().effects).toBe(1);
      await current.close(); current = undefined;
      await chrome.close(); chrome = undefined;

      // The server session is still valid: a new profile must not inherit its cookie or storage.
      chrome = await startOwnedProfileChrome(join(root, 'empty-profile'), fixture.proxy);
      current = actor(chrome, root);
      const isolated = await navigate(current, fixture.origin);
      expect(isolated.state).toEqual({ authenticated: false, local: false, indexed: false, tab: false, cookieReadable: false, effects: 1 });
      await current.close(); current = undefined;
      await chrome.close(); chrome = undefined;

      chrome = await startOwnedProfileChrome(profile, fixture.proxy);
      current = actor(chrome, root);
      expect((await navigate(current, fixture.origin)).state.authenticated).toBe(true);
      fixture.expire();
      const expired = await navigate(current, fixture.origin);
      expect(expired.state.authenticated).toBe(false);
      expect(expired.state.local && expired.state.indexed).toBe(true);
      await current.close(); current = undefined;

      await chrome.ownerGrant(fixture.origin);
      current = actor(chrome, root);
      await navigate(current, fixture.origin);
      await click(current, 'Log out');
      await expect.poll(async () => (await observe(current!)).state.authenticated).toBe(false);
      expect(fixture.stats().effects).toBe(1);
    } finally {
      try { await current?.close(); }
      finally {
        try { await chrome?.close(); }
        finally { try { await fixture.close(); } finally { if (!chrome?.running) await rm(root, { recursive: true, force: true }); } }
      }
    }
  });
});
