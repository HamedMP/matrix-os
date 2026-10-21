import type { PlatformDB } from '../db.js';
import type { GoogleAnalyticsAttribution } from './checkout-schemas.js';

/** Persist even an absent consent snapshot: ambiguous Stripe retries must send identical metadata. */
export async function rememberGoogleAttribution(db: PlatformDB, attemptId: string, owner: string,
  attribution: GoogleAnalyticsAttribution | undefined, at: string): Promise<GoogleAnalyticsAttribution | undefined> {
  return db.transaction(async trx => {
    await trx.executor.insertInto('billing_google_checkout_attribution').values({ attempt_id: attemptId,
      clerk_user_id: owner, payload: JSON.stringify(attribution ?? null), created_at: at,
    }).onConflict(oc => oc.column('attempt_id').doNothing()).execute();
    const snapshot = await trx.executor.selectFrom('billing_google_checkout_attribution').select(['clerk_user_id', 'payload'])
      .where('attempt_id', '=', attemptId).executeTakeFirstOrThrow();
    if (snapshot.clerk_user_id !== owner) throw new Error('Checkout attribution owner mismatch');
    // Only a validated CheckoutRequestSchema payload is ever written here.
    return (JSON.parse(snapshot.payload) as GoogleAnalyticsAttribution | null) ?? undefined;
  });
}
