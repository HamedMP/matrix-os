import {
  claimBillingRuntimeAction,
  completeBillingRuntimeAction,
  listDispatchableBillingRuntimeActions,
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
  suspendForBilling(machineId: string): Promise<void>;
  resumeForBilling(machineId: string): Promise<void>;
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
  const actions = await listDispatchableBillingRuntimeActions(
    input.db,
    currentTime.toISOString(),
    input.batchSize ?? BILLING_RUNTIME_ACTION_BATCH_SIZE,
  );
  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (const action of actions) {
    const claimedAt = now();
    const claimed = await claimBillingRuntimeAction(
      input.db,
      action.id,
      claimedAt.toISOString(),
      new Date(claimedAt.getTime() + BILLING_RUNTIME_ACTION_LEASE_MS).toISOString(),
      BILLING_RUNTIME_ACTION_MAX_ATTEMPTS,
    );
    if (!claimed) continue;

    try {
      if (claimed.action === 'suspend') {
        await input.customerVpsService.suspendForBilling(claimed.machineId);
      } else {
        await input.customerVpsService.resumeForBilling(claimed.machineId);
      }
      if (await completeBillingRuntimeAction(input.db, claimed.id, now().toISOString())) {
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
      }
    }
  }

  return { checked: actions.length, completed, failed, retried };
}
