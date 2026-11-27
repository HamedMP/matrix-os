import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillingEntitlement, upsertBillingEntitlement, type PlatformDB } from '../../packages/platform/src/db.js';
import type { ServerFeatureFlags } from '../../packages/platform/src/feature-flags/server-flags.js';
import type { FreeTierConfig } from '../../packages/platform/src/free-tier/config.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite, getFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeTierRuntime } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Free plan admission behind PostHog runtime switches (ENG-608). Faults
 * detected: free compute admitted while `free-tier-enabled` is off or not yet
 * loaded, the Free offer shown while admission is closed, an admitted owner
 * locked out when admission closes, invites skipped on cold start, and a
 * deployment without a flags key changing behavior.
 */

const OWNER = 'user_flagowner';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const CONFIG: FreeTierConfig = { maxRuntimes: 10, inviteRequired: true };

type FlagValues = Partial<Record<string, boolean>>;

function fakeFlags(values: FlagValues | 'cold'): ServerFeatureFlags & { evaluate: ReturnType<typeof vi.fn> } {
  return {
    configured: true,
    evaluate: vi.fn(async (flag: string) => (values === 'cold' ? undefined : values[flag])),
    shutdown: async () => undefined,
  };
}

describe('free tier admission switches', () => {
  let db: PlatformDB;
  let provision: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb({ serializeTransactions: true }));
    // Admission is what is under test; the metal create is a stub.
    provision = vi.fn(async () => ({ error: 'unavailable' as const }));
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function provisioner(flags: ServerFeatureFlags | undefined, config: FreeTierConfig = CONFIG) {
    const runtime = createFreeTierRuntime({
      db, config, metal: { provision } as never, env: {}, log: () => {}, ...(flags ? { flags } : {}),
    });
    if (!runtime?.provisioner) throw new Error('free tier not composed');
    return runtime.provisioner;
  }

  async function admitted(): Promise<boolean> {
    return (await getBillingEntitlement(db, OWNER))?.source === 'free';
  }

  it.each([
    ['off', fakeFlags({ 'free-tier-enabled': false, 'free-tier-invite-required': true })],
    ['cold start', fakeFlags('cold')],
  ])('refuses new admission and hides the Free offer when free-tier-enabled is %s', async (_label, flags) => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const free = provisioner(flags);

    expect(await free.isEligible(OWNER)).toBe(false);
    expect(await free.provision({ clerkUserId: OWNER, handle: 'flagowner' })).toEqual({ kind: 'plan_unavailable' });
    expect(provision).not.toHaveBeenCalled();
    expect(await admitted()).toBe(false);
    // The invite stays unconsumed for when admission opens.
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
    expect(flags.evaluate).toHaveBeenCalledWith('free-tier-enabled', { distinctId: OWNER });
  });

  it('admits an invited owner when free-tier-enabled is on', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const free = provisioner(fakeFlags({ 'free-tier-enabled': true, 'free-tier-invite-required': true }));

    expect(await free.isEligible(OWNER)).toBe(true);
    await free.provision({ clerkUserId: OWNER, handle: 'flagowner' });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(await admitted()).toBe(true);
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeInstanceOf(Date);
  });

  it('keeps an already admitted owner on the free plan when admission closes', async () => {
    await upsertBillingEntitlement(db, buildFreeEntitlement(OWNER, NOW));
    const free = provisioner(fakeFlags({ 'free-tier-enabled': false }));

    expect(await free.isEligible(OWNER)).toBe(true);
    await free.provision({ clerkUserId: OWNER, handle: 'flagowner' });
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('free-tier-invite-required off admits without an invite; cold start still requires one', async () => {
    const open = provisioner(fakeFlags({ 'free-tier-enabled': true, 'free-tier-invite-required': false }));
    expect(await open.isEligible(OWNER)).toBe(true);

    // The flag is missing from the project: invites stay required even though env says open.
    const missing = provisioner(fakeFlags({ 'free-tier-enabled': true }), { ...CONFIG, inviteRequired: false });
    expect(await missing.isEligible(OWNER)).toBe(false);
    expect(await missing.provision({ clerkUserId: OWNER, handle: 'flagowner' })).toEqual({ kind: 'waitlisted' });
    expect(provision).not.toHaveBeenCalled();

    await open.provision({ clerkUserId: OWNER, handle: 'flagowner' });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(await admitted()).toBe(true);
  });

  it.each([undefined, { configured: false, evaluate: async () => undefined, shutdown: async () => undefined }])(
    'without a flags key, admission follows the env config (%#)', async (flags) => {
      const envOpen = provisioner(flags as ServerFeatureFlags | undefined, { ...CONFIG, inviteRequired: false });
      expect(await envOpen.isEligible(OWNER)).toBe(true);
      const envInvite = provisioner(flags as ServerFeatureFlags | undefined, CONFIG);
      expect(await envInvite.isEligible(OWNER)).toBe(false);

      await envOpen.provision({ clerkUserId: OWNER, handle: 'flagowner' });
      expect(provision).toHaveBeenCalledTimes(1);
      expect(await admitted()).toBe(true);
    },
  );
});
