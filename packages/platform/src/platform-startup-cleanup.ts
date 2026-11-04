export const PLATFORM_STARTUP_CLEANUP_LIMIT = 32;

type StartupCleanup = () => Promise<void>;

export async function runPlatformStartupWithCleanup(
  start: (register: (cleanup: StartupCleanup) => void) => Promise<void>,
): Promise<void> {
  const cleanups: StartupCleanup[] = [];
  try {
    await start(cleanup => {
      if (cleanups.length >= PLATFORM_STARTUP_CLEANUP_LIMIT) {
        throw new Error('Platform startup cleanup capacity exceeded');
      }
      cleanups.push(cleanup);
    });
  } catch (startupError: unknown) {
    // Later workers drain before earlier dependencies. Overlapping ownership
    // registrations retain their resource-specific idempotent close guards.
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      try {
        await cleanup();
      } catch (cleanupError: unknown) {
        console.warn('[platform] Startup cleanup failed:', cleanupError instanceof Error ? 'error' : 'unknown failure');
      }
    }
    throw startupError;
  } finally {
    // Successful startup transfers lifetime ownership to normal shutdown.
    cleanups.length = 0;
  }
}

interface StartupWorker {
  stop(): void;
  drain(): Promise<void>;
}

/** Stop all producers before awaiting any provider pass or closing dependencies. */
export function createPlatformStartupWorkerCleanup(
  readWorkers: () => readonly (StartupWorker | undefined)[],
): StartupCleanup {
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    const workers = readWorkers().filter((worker): worker is StartupWorker => worker !== undefined);
    let failed = false;
    for (const worker of workers) {
      try { worker.stop(); } catch (error: unknown) {
        failed = true;
        console.warn('[platform] Startup worker stop failed:', error instanceof Error ? 'error' : 'unknown failure');
      }
    }
    // A rejected drain must not release the pool while another pass can still
    // journal a provider effect. Async wrappers also capture synchronous throws.
    const drains = await Promise.allSettled(workers.map(async worker => { await worker.drain(); }));
    if (failed || drains.some(result => result.status === 'rejected')) {
      throw new Error('Platform startup worker cleanup failed');
    }
  })();
}
