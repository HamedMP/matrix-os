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
  bindAuthorizedPrebillingFallbackMachine,
  cleanupExpiredPrebillingCheckout,
  createPrebillingIntent,
  getPrebillingIntent,
  listAuthorizedPrebillingFallbackIntents,
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
  const ensureFallback = async (intentId: string) => {
    const current = await getPrebillingIntent(options.db, intentId);
    if (!current || current.state !== 'authorized' || current.machineId !== null) return;
    const identity = await options.resolveIdentity(current.clerkUserId);
    if (!identity) throw new Error('prebilling_identity_unavailable');
    const provisioned = await options.customerVpsService.provision({
      clerkUserId: current.clerkUserId, handle: identity.handle, runtimeSlot: 'primary',
      serverType: current.serverType,
      location: z.enum(['fsn1', 'nbg1', 'ash', 'hil']).parse(current.regionSlug.replace(/^region_/, '')),
      developerTools: current.developerTools,
    }, { dispatch: 'detached' });
    if (!await bindAuthorizedPrebillingFallbackMachine(options.db, {
      intentId, clerkUserId: current.clerkUserId, runtimeSlot: current.runtimeSlot,
      machineId: provisioned.machineId, now: now().toISOString(),
    })) throw new Error('prebilling_fallback_binding_conflict');
    await options.onProvisioned?.({ clerkUserId: current.clerkUserId, handle: identity.handle,
      displayName: identity.displayName, email: identity.email, machineId: provisioned.machineId });
  };
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
      if (!current) return;
      const cost = prebillingHourlyCostMicros(options.config, current.serverType);
      if (cost === null) return;
      const admission = await admitPrebillingIntent(options.db, {
        ...input,
        reservedHourlyCostMicros: cost,
        maxActive: options.config.maxActive,
        maxHourlyCostMicros: options.config.maxHourlyCostMicros,
        now: now().toISOString(),
      });
      if (!admission.admitted) return;
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
    },

    authorizeSubscription(db, input) {
      return authorizePrebillingIntent(db, input);
    },

    async ensureFallback(input) {
      await ensureFallback(input.intentId);
    },

    async reconcileFallbacks() {
      const intents = await listAuthorizedPrebillingFallbackIntents(options.db);
      let completed = 0; let failed = 0;
      for (const intent of intents) {
        try { await ensureFallback(intent.id); completed += 1; }
        catch (err: unknown) {
          failed += 1;
          console.error('[prebilling] fallback reconciliation failed:', err instanceof Error ? err.name : typeof err);
        }
      }
      return { checked: intents.length, completed, failed };
    },

    expireCheckout(db, input) {
      return cleanupExpiredPrebillingCheckout(db, input);
    },
  };
}
