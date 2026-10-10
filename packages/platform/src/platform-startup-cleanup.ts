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
