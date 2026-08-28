import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { PrebillingCheckoutCoordinator } from './billing-routes.js';
import type { CustomerVpsService } from './customer-vps.js';
import type { PlatformDB } from './db.js';
import type { PrebillingProvisioningConfig } from './prebilling-provisioning-config.js';
import {
  prebillingHourlyCostMicros,
  prebillingRolloutIncludesUser,
} from './prebilling-provisioning-config.js';
import {
  admitPrebillingIntent,
  authorizePrebillingIntent,
  cleanupExpiredPrebillingCheckout,
  createPrebillingIntent,
  getPrebillingIntent,
  getPrebillingIntentByCheckoutAttempt,
  markPrebillingPreparationFailed,
} from './prebilling-provisioning-store.js';

export function createPrebillingProvisioningCoordinator(options: {
  db: PlatformDB;
  config: PrebillingProvisioningConfig;
  customerVpsService: CustomerVpsService;
  resolveIdentity: (clerkUserId: string) => Promise<{
    handle: string;
    displayName?: string;
    email?: string;
  } | null | undefined>;
  intentIdFactory?: () => string;
  now?: () => Date;
  onProvisioned?: (input: {
    clerkUserId: string;
    handle: string;
    displayName?: string;
    email?: string;
    machineId: string;
  }) => Promise<void>;
}): PrebillingCheckoutCoordinator {
  const intentIdFactory = options.intentIdFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return {
    async createIntent(input) {
      if (!prebillingRolloutIncludesUser(options.config, input.clerkUserId)) return undefined;
      const cost = prebillingHourlyCostMicros(options.config, input.serverType);
      if (cost === null) return undefined;
      const result = await createPrebillingIntent(options.db, {
        id: intentIdFactory(),
        ...input,
        createdAt: input.now,
      });
      if (!result.selectionMatches || result.intent.checkoutAttemptId !== input.checkoutAttemptId) {
        return undefined;
      }
      return {
        intentId: result.intent.id,
        expiresAt: new Date(Date.parse(input.now) + options.config.leaseMs).toISOString(),
      };
    },

    async startPreparation(input) {
      const current = await getPrebillingIntent(options.db, input.intentId);
      if (!current) return false;
      const cost = prebillingHourlyCostMicros(options.config, current.serverType);
      if (cost === null) return false;
      const admission = await admitPrebillingIntent(options.db, {
        ...input,
        reservedHourlyCostMicros: cost,
        maxActive: options.config.maxActive,
        maxHourlyCostMicros: options.config.maxHourlyCostMicros,
        now: now().toISOString(),
      });
      if (!admission.admitted) return false;
      try {
        const identity = await options.resolveIdentity(current.clerkUserId);
        if (!identity) throw new Error('prebilling_identity_unavailable');
        const provisioned = await options.customerVpsService.provisionForCheckout({
          clerkUserId: current.clerkUserId,
          handle: identity.handle,
          runtimeSlot: 'primary',
          serverType: current.serverType,
          location: z.enum(['fsn1', 'nbg1', 'ash', 'hil']).parse(
            current.regionSlug.replace(/^region_/, ''),
          ),
          developerTools: current.developerTools,
        }, current.id, { dispatch: 'detached' });
        await options.onProvisioned?.({
          clerkUserId: current.clerkUserId,
          handle: identity.handle,
          displayName: identity.displayName,
          email: identity.email,
          machineId: provisioned.machineId,
        });
        return true;
      } catch (err: unknown) {
        await markPrebillingPreparationFailed(options.db, {
          intentId: current.id,
          now: now().toISOString(),
          errorCode: err instanceof Error ? err.name : 'preparation_failed',
        });
        throw err;
      }
    },

    async getPreparationStatus(input) {
      const intent = await getPrebillingIntentByCheckoutAttempt(options.db, input.checkoutAttemptId);
      if (!intent || intent.clerkUserId !== input.clerkUserId) return 'failed';
      if (intent.state === 'ready_waiting_for_billing') return 'ready';
      if (intent.state === 'awaiting_checkout' || intent.state === 'preparing') return 'preparing';
      return 'failed';
    },

    authorizeSubscription(db, input) {
      return authorizePrebillingIntent(db, input);
    },

    expireCheckout(db, input) {
      return cleanupExpiredPrebillingCheckout(db, input);
    },
  };
}
