import {
  claimBillingRuntimeAction,
  finalizeBillingRuntimeAction,
  isBillingRuntimeActionRunnable,
  listDispatchableBillingRuntimeActions,
  listDispatchableBillingRuntimeActionsForMachine,
  retryBillingRuntimeAction,
  type PlatformDB,
} from './db.js';

const BILLING_RUNTIME_ACTION_LEASE_MS = 5 * 60 * 1000;
const BILLING_RUNTIME_ACTION_MAX_ATTEMPTS = 5;
const BILLING_RUNTIME_ACTION_BATCH_SIZE = 20;
const BILLING_RUNTIME_ACTION_RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
] as const;

export interface BillingRuntimeActionService {
  suspendForBilling(machineId: string, shouldContinue?: () => Promise<boolean>): Promise<void>;
  resumeForBilling(machineId: string, shouldContinue?: () => Promise<boolean>): Promise<void>;
}

export interface BillingRuntimeActionDispatchResult {
  checked: number;
  completed: number;
  retried: number;
  failed: number;
}

export async function dispatchBillingRuntimeActions(input: {
  db: PlatformDB;
  customerVpsService: BillingRuntimeActionService;
  now?: () => Date;
  batchSize?: number;
  captureEvent?: (
    event: 'matrix_vps_suspended' | 'matrix_vps_resumed',
    options: { properties: Record<string, string | number | boolean | undefined> },
  ) => void;
}): Promise<BillingRuntimeActionDispatchResult> {
  const now = input.now ?? (() => new Date());
  const currentTime = now();
  const batchSize = Math.max(
    1,
    Math.min(100, Math.trunc(input.batchSize ?? BILLING_RUNTIME_ACTION_BATCH_SIZE)),
  );
  const actions = await listDispatchableBillingRuntimeActions(
    input.db,
    currentTime.toISOString(),
    batchSize,
  );
  const queue = [...actions];
  const queuedActionIds = new Set(queue.map((action) => action.id));
  // Reserve one bounded compensation slot per initially claimed action so a
  // state reversal never waits for the next scheduled worker batch.
  const maxQueuedActions = batchSize * 2;
  let completed = 0;
  let retried = 0;
  let failed = 0;
  let checked = 0;

  const appendDueCompensation = async (machineId: string) => {
    if (queue.length >= maxQueuedActions) return;
    const candidates = await listDispatchableBillingRuntimeActionsForMachine(
      input.db,
      machineId,
      now().toISOString(),
      maxQueuedActions - queue.length,
    );
    for (const candidate of candidates) {
      if (queue.length >= maxQueuedActions) break;
      if (queuedActionIds.has(candidate.id)) continue;
      queuedActionIds.add(candidate.id);
      queue.push(candidate);
    }
  };

  for (const action of queue) {
    checked += 1;
    const claimedAt = now();
    const claimed = await claimBillingRuntimeAction(
      input.db,
      action.id,
      claimedAt.toISOString(),
      new Date(claimedAt.getTime() + BILLING_RUNTIME_ACTION_LEASE_MS).toISOString(),
      BILLING_RUNTIME_ACTION_MAX_ATTEMPTS,
    );
    if (!claimed) continue;
    if (!(await isBillingRuntimeActionRunnable(input.db, claimed.id))) {
      const finalStatus = await finalizeBillingRuntimeAction(
        input.db,
        claimed.id,
        now().toISOString(),
      );
      if (finalStatus === 'canceled') await appendDueCompensation(claimed.machineId);
      continue;
    }

    try {
      const shouldContinue = () => isBillingRuntimeActionRunnable(input.db, claimed.id);
      if (claimed.action === 'suspend') {
        await input.customerVpsService.suspendForBilling(claimed.machineId, shouldContinue);
      } else {
        await input.customerVpsService.resumeForBilling(claimed.machineId, shouldContinue);
      }
      const finalStatus = await finalizeBillingRuntimeAction(input.db, claimed.id, now().toISOString());
      if (finalStatus === 'completed') {
        completed += 1;
        try {
          input.captureEvent?.(
            claimed.action === 'suspend'
              ? 'matrix_vps_suspended'
              : 'matrix_vps_resumed',
            { properties: { reason: claimed.reason, attempt: claimed.attempts } },
          );
        } catch (err: unknown) {
          console.warn(
            `[billing-runtime] telemetry capture failed action=${claimed.action}:`,
            err instanceof Error ? err.name : typeof err,
          );
        }
      } else if (finalStatus === 'canceled') {
        await appendDueCompensation(claimed.machineId);
      }
    } catch (err: unknown) {
      console.error(
        `[billing-runtime] ${claimed.action} failed actionId=${claimed.id} machineId=${claimed.machineId}:`,
        err instanceof Error ? err.name : typeof err,
      );
      const exhausted = claimed.attempts >= BILLING_RUNTIME_ACTION_MAX_ATTEMPTS;
      const retryDelay = BILLING_RUNTIME_ACTION_RETRY_DELAYS_MS[
        Math.min(claimed.attempts - 1, BILLING_RUNTIME_ACTION_RETRY_DELAYS_MS.length - 1)
      ] ?? BILLING_RUNTIME_ACTION_RETRY_DELAYS_MS.at(-1)!;
      const failedAt = now();
      const updated = await retryBillingRuntimeAction(input.db, {
        id: claimed.id,
        nowIso: failedAt.toISOString(),
        nextExecuteAfter: new Date(failedAt.getTime() + retryDelay).toISOString(),
        errorCode: 'runtime_action_failed',
        exhausted,
      });
      if (updated) {
        if (exhausted) failed += 1;
        else retried += 1;
      } else {
        const finalStatus = await finalizeBillingRuntimeAction(
          input.db,
          claimed.id,
          failedAt.toISOString(),
        );
        if (finalStatus === 'canceled') await appendDueCompensation(claimed.machineId);
      }
    }
  }

  return { checked, completed, failed, retried };
}
