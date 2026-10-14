import type { PlatformDB } from './db.js';
import { AccountDeletionAdmissionError } from './account-deletion/admission.js';
import { initializeCustomerFundedStarterPolicy, lockCustomerFundedStarterActivation } from './customer-funded-starter-policy.js';

const ROLLOUT_AT_MS = Date.parse('2026-10-12T17:00:25Z');
interface Result { checked: number; changed: number; failed: number }

/** Bounded historical-owner recovery; authorization and issuance stay in the
 * activation initializer. Keyset progress includes skipped/failed rows so an
 * opt-out or conflicting grant cannot starve subsequent owners. */
export function createCustomerFundedStarterReconciler(options: {
  db: PlatformDB; batchSize: number; now: () => Date; env?: NodeJS.ProcessEnv;
}): () => Promise<Result> {
  const limit = Number.isSafeInteger(options.batchSize) && options.batchSize > 0
    ? Math.min(options.batchSize, 100) : 50;
  let afterMachineId: string | undefined;
  let inFlight: Promise<Result> | undefined;

  async function run(): Promise<Result> {
    const env = options.env ?? process.env;
    const result: Result = { checked: 0, changed: 0, failed: 0 };
    if (env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED !== 'true'
      || env.MATRIX_FUNDED_AI_RUNTIME_ENABLED !== 'true') return result;
    await options.db.ready;
    let query = options.db.executor.selectFrom('user_machines')
      .select(['machine_id', 'clerk_user_id']).where('runtime_slot', '=', 'primary')
      .where('provisioning_class', '=', 'customer').where('status', '=', 'running')
      .where('activation_state', '=', 'authorized').where('deleted_at', 'is', null);
    if (afterMachineId !== undefined) query = query.where('machine_id', '>', afterMachineId);
    const candidates = await query.orderBy('machine_id').limit(limit).execute();
    const checkedAt = options.now().toISOString();
    for (const candidate of candidates) {
      afterMachineId = candidate.machine_id;
      result.checked += 1;
      let outcome = 'unchanged';
      try {
        const changed = await options.db.transaction(async trx => {
          // Acquire deletion/owner admission before the machine lock. Sampling
          // selects work only; all identity/cohort checks are repeated locked.
          await lockCustomerFundedStarterActivation(trx, candidate.clerk_user_id, env);
          const machine = await trx.executor.selectFrom('user_machines')
            .select(['clerk_user_id', 'activation_authorized_at', 'provisioned_at'])
            .where('machine_id', '=', candidate.machine_id).forUpdate().executeTakeFirst();
          if (!machine || machine.clerk_user_id !== candidate.clerk_user_id) return false;
          // Legacy authorized records predate activation timestamps. Their old
          // provisioning time only selects the cohort, never authorizes credit.
          const activationMs = Date.parse(machine.activation_authorized_at ?? machine.provisioned_at);
          if (!Number.isFinite(activationMs) || activationMs >= ROLLOUT_AT_MS) return false;
          return initializeCustomerFundedStarterPolicy(trx, candidate.machine_id, { now: checkedAt, env });
        });
        if (changed) { result.changed += 1; outcome = 'changed'; }
      } catch (error) {
        if (error instanceof AccountDeletionAdmissionError) outcome = 'deletion_pending';
        else {
          result.failed += 1;
          outcome = 'initialization_failed';
          console.error('[funded-starter] Historical reconciliation failed:', error instanceof Error ? error.name : 'UnknownError');
        }
      }
      // Grant/policy provenance remains durable in Postgres; this receipt also
      // records skipped and failed attempts without credentials or owner PII.
      console.info(JSON.stringify({ event: 'funded_starter_reconciliation', machineId: candidate.machine_id,
        checkedAt, outcome }));
    }
    if (candidates.length < limit) afterMachineId = undefined;
    return result;
  }

  return () => {
    inFlight ??= run().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
