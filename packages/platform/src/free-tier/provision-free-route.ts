import { FREE_CAPACITY_FULL_CODE } from '@matrix-os/contracts/free-plan-copy';
import { METAL_PROVISION_MIN_INTERVAL_MS } from '../substrates/metal-provisioner.js';
import type { Context } from 'hono';
import type { PlatformDB } from '../db.js';
import type { FreeProvisionOutcome, FreeRuntimeProvisioner } from './provision-free-runtime.js';

/**
 * The free branch of `POST /api/auth/provision-runtime` (spec 2691, ENG-520;
 * ported from PR #3414 with the runtime reported as `metal`).
 */

/** Retry-After for a full free plan; the journey retry route answers the same. */
export const FREE_CAPACITY_RETRY_AFTER_SECONDS = '60';
const SETUP_RETRY_AFTER_SECONDS = '30';

interface ProvisionIdentity {
  handle: string;
  displayName: string;
  email?: string;
}

export interface FreeProvisionRouteDeps {
  db: PlatformDB;
  appEnv: NodeJS.ProcessEnv;
  provisioner?: FreeRuntimeProvisioner;
  selectProvisionIdentityForClerkUser: (db: PlatformDB, userId: string, env: NodeJS.ProcessEnv) => Promise<ProvisionIdentity | null>;
  ensureProvisionedPlatformUser: (db: PlatformDB, input: {
    clerkUserId: string; handle: string; displayName?: string; email?: string; runtimeId: string;
  }) => Promise<void>;
}

/** Outcomes that mean "this owner is not on the free plan"; the implicit path answers them as billing required. */
const NOT_FREE: ReadonlySet<FreeProvisionOutcome['kind']> = new Set(['waitlisted', 'plan_unavailable', 'runtime_exists', 'checkout_pending']);

/** Maps each outcome to a fixed client response; no provider or database detail reaches the client. */
function respond(c: Context, clerkUserId: string, outcome: FreeProvisionOutcome): Response {
  switch (outcome.kind) {
    case 'created':
    case 'existing':
      return c.json({ runtime: 'metal', clerkUserId, ...outcome.runtime }, 202);
    case 'waitlisted':
      return c.json({ error: 'Free plan is invite only', code: 'waitlisted' }, 403);
    case 'busy':
      c.header('Retry-After', FREE_CAPACITY_RETRY_AFTER_SECONDS);
      return c.json({ error: 'Free capacity is full', code: FREE_CAPACITY_FULL_CODE }, 503);
    case 'runtime_exists':
      return c.json({ error: 'Runtime already exists', code: 'runtime_exists' }, 409);
    case 'plan_unavailable':
      return c.json({ error: 'Free plan unavailable', code: 'free_plan_unavailable' }, 409);
    case 'deletion_pending':
      return c.json({ error: 'Account deletion is pending', code: 'account_deletion_pending' }, 409);
    case 'checkout_pending':
      return c.json({ error: 'A paid checkout is in progress', code: 'checkout_pending' }, 409);
    case 'throttled':
      c.header('Retry-After', String(METAL_PROVISION_MIN_INTERVAL_MS / 1000));
      return c.json({ error: 'Retry later', code: 'retry_throttled' }, 429);
    case 'retry_exhausted':
      return c.json({ error: 'Provisioning retry limit reached', code: 'retry_exhausted' }, 409);
    case 'support_required':
      return c.json({ error: 'Contact support', code: 'support_required' }, 409);
    case 'provisioning_unavailable':
      c.header('Retry-After', SETUP_RETRY_AFTER_SECONDS);
      return c.json({ error: 'Provisioning unavailable', code: 'provisioning_unavailable' }, 503);
  }
}

/**
 * Runs the free branch after the Clerk session is verified. With `implicit`
 * (a request that named no plan and has no paid access), an owner who is not
 * on the free plan gets `null`, so the caller answers 402 billing_required as
 * it does today.
 */
export async function provisionFreeRuntimeForRequest(
  c: Context,
  clerkUserId: string,
  deps: FreeProvisionRouteDeps,
  options: { implicit?: boolean } = {},
): Promise<Response | null> {
  if (!deps.provisioner) {
    if (options.implicit) return null;
    return c.json({ error: 'Free plan unavailable', code: 'free_tier_unavailable' }, 503);
  }
  const identity = await deps.selectProvisionIdentityForClerkUser(deps.db, clerkUserId, deps.appEnv);
  if (!identity) return options.implicit ? null : c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
  const outcome = await deps.provisioner.provision({ clerkUserId, handle: identity.handle });
  if (options.implicit && NOT_FREE.has(outcome.kind)) return null;
  if (outcome.kind === 'created' || outcome.kind === 'existing') {
    await deps.ensureProvisionedPlatformUser(deps.db, {
      clerkUserId,
      handle: outcome.runtime.handle,
      displayName: identity.displayName,
      email: identity.email,
      runtimeId: `metal:${outcome.runtime.machineId}`,
    });
  }
  return respond(c, clerkUserId, outcome);
}
