import { backfillFirstRunRecords } from './journey.js';
import { dispatchBillingRuntimeActions } from './billing-runtime-actions.js';
import type { CustomerVpsService } from './customer-vps-types.js';
import { sweepStaleCheckoutAttempts, type PlatformDB } from './db.js';
import { buildPlatformVerificationToken } from './platform-token.js';
import { logPlatformRouteError } from './platform-route-utils.js';
import type { PrivatePreviewSweepResult } from './private-preview-sweep.js';

export interface CustomerVpsReconciliationWorker {
  /** Stops scheduling new passes. */
  stop(): void;
  /** Resolves when the pass in flight, if any, finishes. */
  drain(): Promise<void>;
}

/** Runs a pass now and on every interval, never overlapping passes. */
export function startCustomerVpsReconciliationWorker(options: {
  intervalMs: number;
  runPass: () => Promise<void>;
}): CustomerVpsReconciliationWorker {
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped || running) return;
    const pass = options.runPass()
      .catch((err: unknown) => {
        logPlatformRouteError('customer VPS reconciliation pass', err);
      })
      .finally(() => {
        if (running === pass) running = undefined;
      });
    running = pass;
  };
  tick();
  const interval = setInterval(tick, options.intervalMs);
  interval.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
    drain() {
      return running ?? Promise.resolve();
    },
  };
}

type BillingRuntimeCaptureEvent = NonNullable<Parameters<typeof dispatchBillingRuntimeActions>[0]['captureEvent']>;

/**
 * One background reconciliation pass, moved from platform-startup.ts. Each
 * step logs and continues on failure so one subsystem cannot starve another.
 */
export async function runCustomerVpsReconciliationPass(deps: {
  db: PlatformDB;
  customerVpsService: CustomerVpsService;
  platformSecret: string;
  customerVpsProxyDispatcher?: import('undici').Dispatcher;
  /** Read at run time: the capture hook is installed after the worker starts. */
  getBillingRuntimeCaptureEvent: () => BillingRuntimeCaptureEvent | undefined;
  sweepPrivatePreviews?: () => Promise<PrivatePreviewSweepResult>;
}): Promise<void> {
  const { db, customerVpsService } = deps;
  try {
    const result = await customerVpsService.reconcileProvisioning();
    if (result.checked > 0) {
      console.log(
        `[platform] customer VPS reconciliation checked=${result.checked} running=${result.running} failed=${result.failed}`,
      );
    }
  } catch (err: unknown) {
    logPlatformRouteError('customer VPS reconciliation', err);
  }
  try {
    const result = await dispatchBillingRuntimeActions({
      db,
      customerVpsService: customerVpsService,
      captureEvent: deps.getBillingRuntimeCaptureEvent(),
    });
    if (result.checked > 0) {
      console.log(
        `[platform] billing runtime actions checked=${result.checked} completed=${result.completed} retried=${result.retried} failed=${result.failed}`,
      );
    }
  } catch (err: unknown) {
    logPlatformRouteError('billing runtime action reconciliation', err);
  }
  try {
    const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await sweepStaleCheckoutAttempts(
      db,
      thirtyDaysAgoIso,
      new Date().toISOString(),
      200,
    );
  } catch (err: unknown) {
    logPlatformRouteError('checkout attempt sweep', err);
  }
  try {
    await backfillFirstRunRecords(db, {
      limit: 25,
      probe: async (machine) => {
        if (!machine.publicIPv4 || !deps.platformSecret) return null;
        const token = buildPlatformVerificationToken(machine.handle, deps.platformSecret);
        const res = await fetch(`https://${machine.publicIPv4}:443/api/settings/onboarding-status`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
          ...(deps.customerVpsProxyDispatcher ? { dispatcher: deps.customerVpsProxyDispatcher } : {}),
        } as RequestInit & { dispatcher?: import('undici').Dispatcher });
        if (!res.ok) return null;
        let body: { complete?: unknown } | null = null;
        try {
          body = (await res.json()) as { complete?: unknown };
        } catch (parseErr: unknown) {
          console.warn(
            `[platform] backfill onboarding-status parse failed machine=${machine.machineId}`,
            parseErr instanceof Error ? parseErr.name : typeof parseErr,
          );
          return null;
        }
        return body?.complete === true ? { completedAt: new Date().toISOString() } : null;
      },
    });
  } catch (err: unknown) {
    logPlatformRouteError('first-run backfill', err);
  }
  if (deps.sweepPrivatePreviews) {
    try {
      const result = await deps.sweepPrivatePreviews();
      if (result.destroyed > 0 || result.failed > 0) {
        console.log(
          `[platform] private preview sweep checked=${result.checked} destroyed=${result.destroyed} failed=${result.failed}`,
        );
      }
    } catch (err: unknown) {
      logPlatformRouteError('private preview sweep', err);
    }
  }
}
