import type { Kysely } from "kysely";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { JevEvaluationRepository } from "./repository.js";
import { startJevResultCleanup } from "./result-cleanup.js";
import { createJevService } from "./service.js";

export async function initializeJevRuntime(options: {
  db: Kysely<any> | null;
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

  // Retention belongs to the owner database lifecycle, even when the paid
  // Jev route is disabled after earlier use. This wrapper never owns the pool.
  const repository = new JevEvaluationRepository(options.db, { now: options.now });
  await repository.bootstrap();
  const service = options.fundedRuntimeEnabled && options.credentialProvider
    ? createJevService({ store: repository, credentialProvider: options.credentialProvider })
    : null;
  const cleanup = startJevResultCleanup({
    repository,
    schedule: options.schedule,
    cancel: options.cancel,
  });
  return { service, cleanup };
}
