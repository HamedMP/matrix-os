import { getAccountDeletionAdmission } from './account-deletion/admission.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { CustomerVpsService } from './customer-vps-types.js';
import { getBillingEntitlementState, getBillingSubscription, type PlatformDB } from './db.js';
import { logPlatformRouteError } from './platform-route-utils.js';

const BATCH_SIZE = 10;
const UNPAID_STATUSES = ['canceled', 'past_due', 'unpaid', 'ended'];

export function createBillingSuspensionReconciliation(deps: {
  db: PlatformDB;
  getServer: HetznerClient['getServer'];
  service: Pick<CustomerVpsService, 'suspendForBilling'>;
  now?: () => Date;
}) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  let cursor: string | undefined;

  const suspended = () => db.executor.selectFrom('user_machines as machine')
    .where('machine.status', '=', 'suspended').where('machine.deleted_at', 'is', null)
    .where('machine.provisioning_class', '=', 'customer')
    .where('machine.activation_state', '=', 'authorized')
    .where('machine.hetzner_server_id', 'is not', null);

  return async () => {
    const targets = await suspended()
      .select(['machine.machine_id', 'machine.clerk_user_id', 'machine.runtime_slot', 'machine.hetzner_server_id'])
      .$if(cursor !== undefined, query => query.where('machine.machine_id', '>', cursor!))
      .where(eb => eb.exists(eb.selectFrom('billing_runtime_actions as action').select('action.id')
        .whereRef('action.machine_id', '=', 'machine.machine_id').where('action.action', '=', 'suspend')
        .where('action.status', '=', 'completed')))
      .orderBy('machine.machine_id').limit(BATCH_SIZE).execute();
    cursor = targets.length === BATCH_SIZE ? targets.at(-1)?.machine_id : undefined;

    for (const target of targets) {
      const { machine_id: machineId, clerk_user_id: owner, runtime_slot: slot, hetzner_server_id: serverId } = target;
      if (serverId === null) continue;
      const shouldContinue = async () => {
        const at = now().toISOString();
        const sub = await getBillingSubscription(db, owner, slot, at);
        if (!sub || !UNPAID_STATUSES.includes(sub.status)
          || (sub.gracePeriodEndsAt !== null && sub.gracePeriodEndsAt >= at)) return false;
        const { entitlement, override } = await getBillingEntitlementState(db, owner, at);
        if (override || (entitlement && entitlement.source !== 'stripe')
          || !(await getAccountDeletionAdmission(db, owner)).newWorkAllowed) return false;

        const eligible = await suspended().select('machine.machine_id')
          .where('machine.machine_id', '=', machineId).where('machine.hetzner_server_id', '=', serverId)
          .where('machine.clerk_user_id', '=', owner).where('machine.runtime_slot', '=', slot)
          .where(eb => eb.exists(eb.selectFrom('billing_runtime_actions as action').select('action.id')
            .whereRef('action.machine_id', '=', 'machine.machine_id')
            .where('action.stripe_subscription_id', '=', sub.stripeSubscriptionId)
            .where('action.action', '=', 'suspend').where('action.status', '=', 'completed')))
          .where(eb => eb.not(eb.exists(eb.selectFrom('billing_runtime_actions as pending').select('pending.id')
            .whereRef('pending.machine_id', '=', 'machine.machine_id').where('pending.status', 'in', ['queued', 'running']))))
          .executeTakeFirst();
        return !!eligible;
      };

      try {
        if (!await shouldContinue()) continue;
        const server = await deps.getServer(serverId);
        if (server?.id === serverId && server.status === 'running') {
          await deps.service.suspendForBilling(machineId, shouldContinue);
        }
      } catch (error: unknown) {
        logPlatformRouteError('customer VPS billing suspension drift', error);
      }
    }
  };
}
