import type { PlatformDB } from '../db.js';
import { sql } from 'kysely';
import { withAccountDeletionOwnerLock } from './admission.js';

/** Project confirmed provider cancellation without recreating any erased owner data. */
export async function projectAccountDeletionBillingCancellation(
  db: PlatformDB,
  input: { clerkUserId: string; stripeSubscriptionId?: string; stripeCustomerId?: string; at?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await withAccountDeletionOwnerLock(db, input.clerkUserId, async (trx) => {
    if (input.stripeSubscriptionId) {
      const existing = await trx.executor.selectFrom('billing_subscriptions')
        .select(['clerk_user_id', 'stripe_customer_id']).where('stripe_subscription_id', '=', input.stripeSubscriptionId)
        .forUpdate().executeTakeFirst();
      if (existing && (existing.clerk_user_id !== input.clerkUserId
        || (input.stripeCustomerId && existing.stripe_customer_id !== input.stripeCustomerId))) {
        throw new Error('Billing cancellation identity mismatch');
      }
    }
    await trx.executor.updateTable('billing_subscriptions').set({ status: 'canceled', grace_period_ends_at: null, updated_at: at,
      latest_event_created_at: sql`GREATEST(latest_event_created_at, ${at})`,
      latest_event_id: sql`CASE WHEN latest_event_created_at <= ${at} THEN 'zz_account_deletion_cancel' ELSE latest_event_id END`,
    })
      .where('clerk_user_id', '=', input.clerkUserId)
      .$if(Boolean(input.stripeSubscriptionId), q => q.where('stripe_subscription_id', '=', input.stripeSubscriptionId!))
      .$if(Boolean(input.stripeCustomerId), q => q.where('stripe_customer_id', '=', input.stripeCustomerId!)).execute();
    await trx.executor.updateTable('billing_entitlements').set({ status: 'canceled', grace_period_ends_at: null, effective_until: at, updated_at: at })
      .where('clerk_user_id', '=', input.clerkUserId).where('source', '=', 'stripe')
      .$if(Boolean(input.stripeSubscriptionId), q => q.where('stripe_subscription_id', '=', input.stripeSubscriptionId!)).execute();
  }, env);
}
