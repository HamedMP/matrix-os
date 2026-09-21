/**
 * Owner-database fallback teardown (S20 / T099).
 *
 * When the owner PostgreSQL bootstrap fails part-way through gateway startup,
 * every database-backed service built so far must be torn down before the
 * gateway continues in the file-storage fallback, so no Chat event stream,
 * repository or collaboration runtime keeps a reference to a destroyed pool.
 * Order matters: the collaboration runtime drains first (bounded; if it
 * cannot complete it is fenced so it refuses new work and detaches its
 * handles), the Chat event stream stops publishing before its repository is
 * released, and the pool is destroyed last. Each step is isolated so one
 * failure cannot leak the others.
 */
export interface OwnerDatabaseFallbackServices {
  collaboration?: { shutdown(): Promise<void>; fence?(): void } | null;
  chatEventStream?: { shutdown(): void } | null;
  chatRepository?: { release(): Promise<void> } | null;
  canvasRepository?: { destroy(): Promise<void> } | null;
  appDb?: { destroy(): Promise<void> } | null;
}

export type OwnerDatabaseFallbackStep =
  | "collaboration"
  | "collaborationFenced"
  | "chatEventStream"
  | "chatRepository"
  | "canvasRepository"
  | "appDb";

export const DEFAULT_COLLABORATION_DRAIN_TIMEOUT_MS = 10_000;

export async function teardownOwnerDatabaseServices(
  services: OwnerDatabaseFallbackServices,
  options: {
    warn?: (step: OwnerDatabaseFallbackStep, error: unknown) => void;
    collaborationDrainTimeoutMs?: number;
  } = {},
): Promise<OwnerDatabaseFallbackStep[]> {
  const warn = options.warn ?? ((step, error) => {
    console.warn(`[app-db] Fallback teardown failed at ${step}:`, error instanceof Error ? error.name : "UnknownError");
  });
  const completed: OwnerDatabaseFallbackStep[] = [];

  if (services.collaboration) {
    const drained = await drainCollaboration(
      services.collaboration,
      options.collaborationDrainTimeoutMs ?? DEFAULT_COLLABORATION_DRAIN_TIMEOUT_MS,
      warn,
    );
    completed.push(drained ? "collaboration" : "collaborationFenced");
  } else {
    completed.push("collaboration");
  }

  const steps: [OwnerDatabaseFallbackStep, () => Promise<void> | void][] = [
    ["chatEventStream", () => services.chatEventStream?.shutdown()],
    ["chatRepository", () => services.chatRepository?.release()],
    ["canvasRepository", () => services.canvasRepository?.destroy()],
    ["appDb", () => services.appDb?.destroy()],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
      completed.push(step);
    } catch (error: unknown) {
      warn(step, error);
    }
  }
  return completed;
}

/**
 * Waits up to `timeoutMs` for the runtime to drain. A drain that throws or
 * hangs leaves a runtime that still references the pool, so the runtime is
 * fenced (no new work, handles detached) before the caller destroys anything.
 * Returns true when the drain completed.
 */
async function drainCollaboration(
  runtime: NonNullable<OwnerDatabaseFallbackServices["collaboration"]>,
  timeoutMs: number,
  warn: (step: OwnerDatabaseFallbackStep, error: unknown) => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("CollaborationDrainTimeout")), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([runtime.shutdown(), timeout]);
    return true;
  } catch (error: unknown) {
    warn("collaboration", error);
    try {
      runtime.fence?.();
    } catch (fenceError: unknown) {
      warn("collaborationFenced", fenceError);
    }
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
