type Cleanup = () => unknown | Promise<unknown>;

/** Register each acquired test resource immediately; release all in reverse order. */
export async function withEvidenceCleanup<T>(
  run: (register: (cleanup: Cleanup) => void) => Promise<T>,
): Promise<T> {
  const cleanups: Cleanup[] = [];
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const value = await run((cleanup) => {
      if (cleanups.length >= 32) throw new Error("Evidence resource limit exceeded");
      cleanups.push(cleanup);
    });
    outcome = { ok: true, value };
  } catch (error) { outcome = { ok: false, error }; }

  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [...(!outcome.ok ? [outcome.error] : []), ...cleanupErrors],
      "Evidence cleanup failed",
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
