import type { UserMachineRecord } from '../db.js';
import type { AppDomainIdentity } from '../session-routing-identity.js';

/**
 * The shell's plans entry point (`/?plans=1`, see `PLANS_PATH`). OnboardingGate
 * opens the billing screen for any root URL carrying `plans`, so this matches
 * the same set.
 */
export function isPlansEntryRequest(method: string, rawUrl: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    return url.pathname === '/' && url.searchParams.has('plans');
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) throw err;
    return false;
  }
}

/**
 * A container owner's shell is served by their unit, which is stopped at the
 * compute cap. The platform serves the plans screen from its own app shell
 * instead, so "See paid plans" works without waking the unit. VPS owners and
 * anyone who is not the machine's owner keep today's routing.
 */
export function shouldServeContainerPlansFromPlatform(input: {
  isAppDomain: boolean;
  method: string;
  rawUrl: string;
  userId: string;
  identitySource: AppDomainIdentity['source'];
  machine: Pick<UserMachineRecord, 'substrate' | 'clerkUserId'> | undefined;
}): boolean {
  return Boolean(
    input.isAppDomain
    && input.userId
    && input.identitySource !== 'mobile-session'
    && input.identitySource !== 'static-route'
    && input.machine?.substrate === 'container'
    && input.machine.clerkUserId === input.userId
    && isPlansEntryRequest(input.method, input.rawUrl),
  );
}
