import {
  PLATFORM_FEATURE_FLAGS,
  resolveRuntimeSwitch,
  type RuntimeSwitch,
  type ServerFeatureFlags,
} from '../feature-flags/server-flags.js';
import type { FreeTierConfig } from './config.js';

/**
 * Free plan runtime switches (ENG-608). The env layer (`MATRIX_FREE_TIER_*`)
 * still decides whether the free tier is installed here and holds its limits;
 * these PostHog flags turn it on and off and roll it out per Clerk user.
 *
 * | Flag | Configured, flag known | Cold start / missing flag | No key configured |
 * | --- | --- | --- | --- |
 * | `free-tier-enabled` | flag | closed: no new admission | open (env enabled it) |
 * | `free-tier-invite-required` | flag | invites required | `MATRIX_FREE_TIER_INVITE_REQUIRED` |
 * | `free-tier-sleep` | flag | no suspends | sleeps (env enabled it) |
 *
 * Owners already admitted (a stored free entitlement) keep their runtime when
 * admission is closed; only new admissions and the Free offer stop.
 */
export interface FreeTierSwitches {
  /** Whether a new owner may be admitted to the free plan (and be offered it). */
  admissionOpen(clerkUserId: string): Promise<boolean>;
  /** Whether admitting this owner requires an unconsumed invite. */
  inviteRequired(clerkUserId: string): Promise<boolean>;
}

/** Whether the idle sleeper may suspend this owner's free runtime. Scheduled wakes ignore it. */
export type FreeTierSleepSwitch = (clerkUserId: string) => Promise<boolean>;

const ADMISSION: RuntimeSwitch = { flag: PLATFORM_FEATURE_FLAGS.freeTierEnabled, whenUnconfigured: true, whenUnknown: false };
const SLEEP: RuntimeSwitch = { flag: PLATFORM_FEATURE_FLAGS.freeTierSleep, whenUnconfigured: true, whenUnknown: false };

export function createFreeTierSwitches(flags: ServerFeatureFlags | undefined, config: FreeTierConfig): FreeTierSwitches {
  const invite: RuntimeSwitch = {
    flag: PLATFORM_FEATURE_FLAGS.freeTierInviteRequired, whenUnconfigured: config.inviteRequired, whenUnknown: true,
  };
  return {
    admissionOpen: (clerkUserId) => resolveRuntimeSwitch(flags, ADMISSION, { distinctId: clerkUserId }),
    inviteRequired: (clerkUserId) => resolveRuntimeSwitch(flags, invite, { distinctId: clerkUserId }),
  };
}

export function createFreeTierSleepSwitch(flags: ServerFeatureFlags | undefined): FreeTierSleepSwitch {
  return (clerkUserId) => resolveRuntimeSwitch(flags, SLEEP, { distinctId: clerkUserId });
}
