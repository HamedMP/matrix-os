import { getBillingCustomerByStripeCustomerId, type PlatformDB } from '../db.js';
import type { StripeBillingClient } from '../billing/stripe-client.js';
import { withAccountDeletionAdmission } from './admission.js';

/** Fence outbound billing creates through the bounded provider call, before deletion acceptance can commit. */
export function createAccountDeletionGuardedStripeClient(
  db: PlatformDB,
  client: StripeBillingClient,
  env: NodeJS.ProcessEnv = process.env,
): StripeBillingClient {
  return {
    apiTimeoutMs: client.apiTimeoutMs,
    createCheckoutSession: (input) => withAccountDeletionAdmission(db, input.clerkUserId,
      async () => client.createCheckoutSession(input), env),
    createAiCreditCheckoutSession: (input) => withAccountDeletionAdmission(db, input.clerkUserId,
      async () => client.createAiCreditCheckoutSession(input), env),
    createPortalSession: async (input) => {
      const customer = await getBillingCustomerByStripeCustomerId(db, input.customerId);
      if (!customer) throw new Error('Billing unavailable');
      return withAccountDeletionAdmission(db, customer.clerkUserId,
        async () => client.createPortalSession(input), env);
    },
    retrieveCheckoutSession: client.retrieveCheckoutSession.bind(client),
    retrieveRecurringPrice: client.retrieveRecurringPrice.bind(client),
    constructWebhookEvent: client.constructWebhookEvent.bind(client),
    ...(client.clearSubscriptionAttribution
      ? { clearSubscriptionAttribution: client.clearSubscriptionAttribution.bind(client) } : {}),
  };
}
