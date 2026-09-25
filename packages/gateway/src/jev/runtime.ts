import type { Kysely } from "kysely";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { createOwnedJevMaintenance, type JevMaintenancePoolFactory } from "./owned-maintenance.js";
import { JevEvaluationRepository } from "./repository.js";
import { startJevResultCleanup } from "./result-cleanup.js";
import { createJevService } from "./service.js";

export async function initializeJevRuntime(options: {
  db: Kysely<any> | null;
  databaseUrl?: string;
  maintenanceRepositoryForTests?: Pick<JevEvaluationRepository, "pruneExpiredCompletedResults">;
  maintenancePoolFactory?: JevMaintenancePoolFactory;
  credentialProvider?: MatrixFundedCredentialProvider | null;
  fundedRuntimeEnabled: boolean;
  now?: () => Date;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}): Promise<{
  service: ReturnType<typeof createJevService> | null;
  cleanup: ReturnType<typeof startJevResultCleanup>;
} | null> {
  if (!options.db) return null;
  if (!options.databaseUrl && !options.maintenanceRepositoryForTests) {
    throw new Error("Jev maintenance database URL required");
  }

  // Retention belongs to the owner database lifecycle, even when the paid
  // Jev route is disabled after earlier use. This wrapper never owns the pool.
  const repository = new JevEvaluationRepository(options.db, { now: options.now });
  await repository.bootstrap();
  const service = options.fundedRuntimeEnabled && options.credentialProvider
    ? createJevService({ store: repository, credentialProvider: options.credentialProvider })
    : null;
  const ownedMaintenance = options.databaseUrl
    ? createOwnedJevMaintenance({
      databaseUrl: options.databaseUrl,
      now: options.now,
      poolFactory: options.maintenancePoolFactory,
    })
    : null;
  const maintenanceRepository = ownedMaintenance?.repository ?? options.maintenanceRepositoryForTests;
  if (!maintenanceRepository) throw new Error("Jev maintenance repository unavailable");
  const lifecycle = startJevResultCleanup({
    repository: maintenanceRepository,
    abortInFlight: ownedMaintenance?.forceReleaseActive,
    schedule: options.schedule,
    cancel: options.cancel,
  });
  const cleanup = {
    runNow: lifecycle.runNow,
    async close() {
      await lifecycle.close();
      await ownedMaintenance?.close();
    },
  };
  return { service, cleanup };
}
