import type { AccountDeletionService } from './types.js';

export interface AccountDeletionWorker { stop(): void; drain(): Promise<void>; }
export function startAccountDeletionWorker(options: {
  service: AccountDeletionService;
  intervalMs?: number;
  logError?: (error: unknown) => void;
}): AccountDeletionWorker {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    const pass = options.service.reconcile()
      .catch((error: unknown) => {
        if (options.logError) options.logError(error);
        else console.error('[platform] account deletion worker failed', error);
      }).finally(() => { if (running === pass) running = undefined; });
    running = pass;
  };
  const timer = setInterval(tick, Math.max(1000, options.intervalMs ?? 30_000));
  timer.unref?.();
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, drain() { return running ?? Promise.resolve(); } };
}
