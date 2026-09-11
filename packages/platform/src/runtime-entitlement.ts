import type { PlatformDB } from './db.js';
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
  if (provisioningClass === 'preview') {
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
