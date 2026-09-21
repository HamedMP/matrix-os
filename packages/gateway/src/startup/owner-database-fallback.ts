/**
 * Owner-database fallback teardown (S20 / T099).
 *
 * When the owner PostgreSQL bootstrap fails part-way through gateway startup,
 * every database-backed service built so far must be torn down before the
 * gateway continues in the file-storage fallback, so no Chat event stream,
 * repository or collaboration runtime keeps a reference to a destroyed pool.
 * Order matters: the Chat event stream stops publishing before its repository
 * is released, the collaboration runtime drains before that, and the pool is
 * destroyed last. Each step is isolated so one failure cannot leak the others.
 */
export interface OwnerDatabaseFallbackServices {
  collaboration?: { shutdown(): Promise<void> } | null;
  chatEventStream?: { shutdown(): void } | null;
  chatRepository?: { release(): Promise<void> } | null;
  canvasRepository?: { destroy(): Promise<void> } | null;
  appDb?: { destroy(): Promise<void> } | null;
}

export type OwnerDatabaseFallbackStep = "collaboration" | "chatEventStream" | "chatRepository" | "canvasRepository" | "appDb";

export async function teardownOwnerDatabaseServices(
  services: OwnerDatabaseFallbackServices,
  options: { warn?: (step: OwnerDatabaseFallbackStep, error: unknown) => void } = {},
): Promise<OwnerDatabaseFallbackStep[]> {
  const warn = options.warn ?? ((step, error) => {
    console.warn(`[app-db] Fallback teardown failed at ${step}:`, error instanceof Error ? error.name : "UnknownError");
  });
  const completed: OwnerDatabaseFallbackStep[] = [];
  const steps: [OwnerDatabaseFallbackStep, () => Promise<void> | void][] = [
    ["collaboration", () => services.collaboration?.shutdown()],
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
