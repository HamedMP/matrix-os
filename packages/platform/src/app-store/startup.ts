import type { PrivatePreviewEligibility } from '../private-preview-eligibility.js';
import type { PlatformDB } from '../db.js';
import { readStoreConfiguration } from './reviewer-allowlist.js';
import { createStoreObjects, type AppStoreObjectStorage } from './object-store.js';
import { createAppStoreRepository } from './repository.js';
import { createStoreIntake } from './intake.js';
import { createReviewService } from './review-service.js';
import { createStoreInternalRoutes, type StoreRouteDeps } from './internal-routes.js';
import { createStoreReviewRoutes } from './review-routes.js';
import { createStoreSweeper } from './sweeper.js';
export function createConfiguredAppStoreRuntime(options: { db: PlatformDB; env: NodeJS.ProcessEnv; platformSecret: string; objectStore?: AppStoreObjectStorage; privatePreviewEligibility?: PrivatePreviewEligibility }) {
  const config = readStoreConfiguration(options.env);
  const repository = createAppStoreRepository(options.db, { signing: config.signing });
  const objects = options.objectStore ? createStoreObjects(options.objectStore) : undefined;
  const deps: StoreRouteDeps = { db: options.db, platformSecret: options.platformSecret, config, repository, objects, env: options.env, privatePreviewEligibility: options.privatePreviewEligibility,
    review: objects ? createReviewService(options.db, repository, objects) : undefined,
    finalize: objects ? createStoreIntake(options.db, repository, objects) : undefined };
  const routes = createStoreInternalRoutes(deps); routes.route('/review', createStoreReviewRoutes(deps));
  const sweeper = config.enabled && objects ? createStoreSweeper(options.db, objects) : undefined;
  // This runtime borrows both DB and object storage; their creator owns closure.
  return { routes, repository, start: () => sweeper?.start(), shutdown: async () => { await sweeper?.shutdown(); } };
}
