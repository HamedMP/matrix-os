import type { Context } from 'hono';
import type { PlatformDB } from '../db.js';
import type { FreeProvisionOutcome, FreeRuntimeProvisioner } from './provision-free-runtime.js';

const BUSY_RETRY_AFTER_SECONDS = '60';
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

/** Maps each outcome to a fixed client response; no provider or database detail reaches the client. */
function respond(c: Context, clerkUserId: string, outcome: FreeProvisionOutcome): Response {
  switch (outcome.kind) {
    case 'created':
    case 'existing':
      return c.json({ runtime: 'container', clerkUserId, ...outcome.runtime }, 202);
    case 'waitlisted':
      return c.json({ error: 'Free plan is invite only', code: 'waitlisted' }, 403);
    case 'busy':
      c.header('Retry-After', BUSY_RETRY_AFTER_SECONDS);
      return c.json({ error: 'Free capacity is full', code: 'busy' }, 503);
    case 'runtime_exists':
      return c.json({ error: 'Runtime already exists', code: 'runtime_exists' }, 409);
    case 'plan_unavailable':
      return c.json({ error: 'Free plan unavailable', code: 'free_plan_unavailable' }, 409);
    case 'deletion_pending':
      return c.json({ error: 'Account deletion is pending', code: 'account_deletion_pending' }, 409);
    case 'database_unavailable':
      c.header('Retry-After', SETUP_RETRY_AFTER_SECONDS);
      return c.json({ error: 'Provisioning unavailable', code: 'provisioning_unavailable' }, 503);
  }
}

/** The free branch of `POST /api/auth/provision-runtime`, after the Clerk session is verified. */
export async function provisionFreeRuntimeForRequest(
  c: Context,
  clerkUserId: string,
  deps: FreeProvisionRouteDeps,
): Promise<Response> {
  if (!deps.provisioner) {
    return c.json({ error: 'Free plan unavailable', code: 'free_tier_unavailable' }, 503);
  }
  const identity = await deps.selectProvisionIdentityForClerkUser(deps.db, clerkUserId, deps.appEnv);
  if (!identity) return c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
  const outcome = await deps.provisioner.provision({ clerkUserId, handle: identity.handle });
  if (outcome.kind === 'created' || outcome.kind === 'existing') {
    await deps.ensureProvisionedPlatformUser(deps.db, {
      clerkUserId,
      handle: outcome.runtime.handle,
      displayName: identity.displayName,
      email: identity.email,
      runtimeId: `container:${outcome.runtime.machineId}`,
    });
  }
  return respond(c, clerkUserId, outcome);
}
