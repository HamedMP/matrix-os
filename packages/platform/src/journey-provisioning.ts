import { getRuntimeAccessDecision, type BillingEntitlement } from './billing.js';
import type { CustomerVpsService } from './customer-vps.js';
import { AccountDeletionAdmissionError } from './account-deletion/admission.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { getActiveUserMachineByClerkId, type PlatformDB } from './db.js';
import { FREE_RUNTIME_SLOT } from './free-tier/free-entitlement.js';
import type { FreeRuntimeProvisioner } from './free-tier/provision-free-runtime.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';

/**
 * The onboarding journey's provisioning trigger (spec 092), moved out of
 * main.ts. It uses the same building blocks as `POST /api/auth/provision-runtime`
 * so billing and identity checks stay identical, including the free plan on
 * metal (spec 2691): an owner without paid access who can take the free plan
 * gets their free metal runtime instead of 402; everyone else keeps 402.
 */

interface ProvisionIdentity {
  handle: string;
  displayName: string;
  email?: string;
}

export interface JourneyProvisionerDeps {
  db: PlatformDB;
  appEnv: NodeJS.ProcessEnv;
  customerVpsService?: CustomerVpsService;
  freeRuntimeProvisioner?: FreeRuntimeProvisioner;
  matrixProvisioner?: MatrixProvisioner;
  stripeBillingEntitlementsEnabled: (env: NodeJS.ProcessEnv) => boolean;
  resolveEffectiveBillingEntitlement: (
    db: PlatformDB, clerkUserId: string, now?: Date, runtimeSlot?: string, env?: NodeJS.ProcessEnv,
  ) => Promise<BillingEntitlement | null>;
  selectProvisionIdentityForClerkUser: (db: PlatformDB, userId: string, env: NodeJS.ProcessEnv) => Promise<ProvisionIdentity | null>;
  ensureProvisionedPlatformUser: (db: PlatformDB, input: {
    clerkUserId: string; handle: string; displayName?: string; email?: string; runtimeId: string;
  }) => Promise<void>;
}

const billingRequired = () => new CustomerVpsError(402, 'billing_required', 'Billing upgrade required');

export function createJourneyProvisioner(
  deps: JourneyProvisionerDeps,
): ((clerkUserId: string, runtimeSlot: string) => Promise<void>) | undefined {
  if (!deps.customerVpsService && !deps.freeRuntimeProvisioner) return undefined;
  const { db, appEnv } = deps;

  async function provisionMatrixAccounts(handle: string): Promise<void> {
    if (!deps.matrixProvisioner) return;
    try {
      await deps.matrixProvisioner.provisionUser(handle);
    } catch (matrixErr: unknown) {
      console.error(
        `[matrix] Failed to provision Matrix accounts for ${handle}:`,
        matrixErr instanceof Error ? matrixErr.message : String(matrixErr),
      );
    }
  }

  /** The free metal path; `null` means the owner is not on the free plan. */
  async function provisionFree(clerkUserId: string, runtimeSlot: string): Promise<true | null> {
    const free = deps.freeRuntimeProvisioner;
    if (!free || runtimeSlot !== FREE_RUNTIME_SLOT) return null;
    const identity = await deps.selectProvisionIdentityForClerkUser(db, clerkUserId, appEnv);
    if (!identity) return null;
    const outcome = await free.provision({ clerkUserId, handle: identity.handle });
    switch (outcome.kind) {
      case 'created':
      case 'existing':
        await deps.ensureProvisionedPlatformUser(db, {
          clerkUserId,
          handle: outcome.runtime.handle,
          displayName: identity.displayName,
          email: identity.email,
          runtimeId: `metal:${outcome.runtime.machineId}`,
        });
        return true;
      case 'busy':
        throw new CustomerVpsError(503, 'free_capacity_full', 'Free capacity is full');
      case 'provisioning_unavailable':
        throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
      case 'throttled':
        throw new CustomerVpsError(429, 'retry_throttled', 'Retry later');
      case 'retry_exhausted':
        throw new CustomerVpsError(409, 'retry_exhausted', 'Provisioning retry limit reached');
      case 'support_required':
        throw new CustomerVpsError(409, 'support_required', 'Contact support');
      case 'deletion_pending':
        throw new AccountDeletionAdmissionError();
      default:
        return null;
    }
  }

  return async function provisionRuntimeForJourney(clerkUserId: string, runtimeSlot: string): Promise<void> {
    if (deps.stripeBillingEntitlementsEnabled(appEnv) || deps.freeRuntimeProvisioner) {
      const checkedAt = new Date();
      const entitlement = await deps.resolveEffectiveBillingEntitlement(db, clerkUserId, checkedAt, runtimeSlot, appEnv);
      if (!getRuntimeAccessDecision(entitlement, checkedAt).runtimeProxyAllowed) {
        if (await provisionFree(clerkUserId, runtimeSlot)) return;
        throw billingRequired();
      }
    }
    if (!deps.customerVpsService) {
      throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
    }
    const identity = await deps.selectProvisionIdentityForClerkUser(db, clerkUserId, appEnv);
    if (!identity) {
      throw new CustomerVpsError(409, 'invalid_state', 'Handle unavailable');
    }
    const existingMachine = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
    const provisioned = await deps.customerVpsService.provision({
      handle: identity.handle,
      clerkUserId,
      runtimeSlot,
      ...(existingMachine?.status === 'failed' ? { developerTools: existingMachine.developerTools } : {}),
    });
    await deps.ensureProvisionedPlatformUser(db, {
      clerkUserId,
      handle: identity.handle,
      displayName: identity.displayName,
      email: identity.email,
      runtimeId: `vps:${provisioned.machineId}`,
    });
    await provisionMatrixAccounts(identity.handle);
  };
}
