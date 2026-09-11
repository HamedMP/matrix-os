interface PendingDeletionRegistry {
  delete(name: string, options: { force: true }): Promise<void>;
}

interface PendingDeletionLifecycle {
  listPendingSessionDeletions(): Promise<string[]>;
  withSessionLifecycleLock<T>(name: string, operation: () => Promise<T>): Promise<T>;
  completeSessionDeletion(name: string): Promise<void>;
}

export async function reconcilePendingShellSessionDeletions(options: {
  registry: PendingDeletionRegistry;
  lifecycle: PendingDeletionLifecycle;
}): Promise<{ completed: number; failed: number }> {
  let pendingNames: string[];
  try {
    pendingNames = await options.lifecycle.listPendingSessionDeletions();
  } catch (error: unknown) {
    console.warn("[terminal-lifecycle] pending deletion scan failed:", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { completed: 0, failed: 1 };
  }
  let completed = 0;
  let failed = 0;

  for (const name of pendingNames) {
    try {
      await options.lifecycle.withSessionLifecycleLock(name, async () => {
        await options.registry.delete(name, { force: true });
        await options.lifecycle.completeSessionDeletion(name);
      });
      completed += 1;
    } catch (error: unknown) {
      failed += 1;
      console.warn("[terminal-lifecycle] pending deletion reconciliation failed:", {
        name,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  return { completed, failed };
}
