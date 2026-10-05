import type { PlatformDB } from './db.js';
import { getAccountDeletionAdmission } from './account-deletion/admission.js';
import { deriveEntitlementAccess, EntitlementStatusSchema, type EntitlementAccessDecision } from './profile-routing.js';
import { getRuntimeAccessDecision, type BillingEntitlement, type RuntimeAccessDecision } from './billing.js';
import { resolveEffectiveBillingEntitlementForSlot } from './billing-entitlement-resolver.js';

export function getRuntimeEntitlementDecision(env: NodeJS.ProcessEnv = process.env): EntitlementAccessDecision {
  const rawStatus = env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS?.trim();
  if (!rawStatus) {
    return deriveEntitlementAccess({ status: 'active' });
  }
  const parsed = EntitlementStatusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    console.warn('[platform] Invalid MATRIX_PAID_BETA_ENTITLEMENT_STATUS; denying paid runtime access.');
    return deriveEntitlementAccess({ status: 'changed' });
  }
  return deriveEntitlementAccess({ status: parsed.data });
}

export function stripeBillingEntitlementsEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.MATRIX_STRIPE_BILLING_ENABLED === 'true' ||
    env.MATRIX_BILLING_PROVIDER === 'stripe' ||
    Boolean(env.STRIPE_SECRET_KEY?.trim())
  );
}

export async function resolveEffectiveBillingEntitlement(
  db: PlatformDB,
  clerkUserId: string,
  now = new Date(),
  runtimeSlot?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BillingEntitlement | null> {
  return resolveEffectiveBillingEntitlementForSlot(db, clerkUserId, now, runtimeSlot, env);
}

export async function getRuntimeEntitlementDecisionForUser(
  db: PlatformDB,
  clerkUserId: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeSlot?: string,
  provisioningClass?: string,
  now = new Date(),
): Promise<EntitlementAccessDecision> {
  const deletion = await getAccountDeletionAdmission(db, clerkUserId, env, now);
  if (deletion.runtimeAccess !== 'normal') {
    const existing = deletion.runtimeAccess === 'grace'
      ? await db.executor.selectFrom('user_machines').select('machine_id')
        .where('clerk_user_id', '=', clerkUserId).where('deleted_at', 'is', null)
        .where('activation_state', '=', 'authorized').where('status', 'in', ['running', 'recovering'])
        .where('provisioned_at', '<=', deletion.scheduledAt!)
        .$if(Boolean(runtimeSlot), (query) => query.where('runtime_slot', '=', runtimeSlot!))
        .executeTakeFirst()
      : undefined;
    return {
      status: existing ? 'active' : 'disabled', runtimeProxyAllowed: Boolean(existing),
      ownerDataPreserved: true, ownerDataExportable: true,
      remediation: existing ? null : 'Account deletion is pending.',
    };
  }
  // Preview and Private Preview machines are platform-funded and bounded by their own quotas.
  if (provisioningClass === 'preview' || provisioningClass === 'private-preview') {
    return {
      status: 'active',
      runtimeProxyAllowed: true,
      ownerDataPreserved: true,
      ownerDataExportable: true,
      remediation: null,
    };
  }
  if (!stripeBillingEntitlementsEnabled(env)) {
    return getRuntimeEntitlementDecision(env);
  }
  return billingAccessToProfileDecision(
    getRuntimeAccessDecision(await resolveEffectiveBillingEntitlement(db, clerkUserId, now, runtimeSlot, env), now),
  );
}

function billingAccessToProfileDecision(decision: RuntimeAccessDecision): EntitlementAccessDecision {
  if (decision.runtimeProxyAllowed) {
    return {
      status: 'active',
      runtimeProxyAllowed: true,
      ownerDataPreserved: true,
      ownerDataExportable: true,
      remediation: null,
    };
  }
  return {
    status: decision.reason === 'no_entitlement' ? 'missing' : 'expired',
    runtimeProxyAllowed: false,
    ownerDataPreserved: true,
    ownerDataExportable: true,
    remediation: 'Renew paid runtime access or ask an operator to grant access.',
  };
}
