import { createFundedModelProbeService, loadFundedModelProbeLimits } from '../ai-funded-model-probes.js';
import type { AiFundedPolicyRepository } from '../ai-funded-policy-repository.js';
import type { PlatformDB } from '../db.js';
import { createAiFundedRelayRoutes } from '../ai-funded-policy-routes.js';
import { configureOperatorProbes } from './adapter.js';

/** Compose both sides of the source Platform from one configured wallet. */
export function createConfiguredProbeServices(db: PlatformDB, repository: AiFundedPolicyRepository,
  relayControlToken: string, platformDatabaseUrl: string, env = process.env) {
  const operator = configureOperatorProbes(env, platformDatabaseUrl, relayControlToken);
  return {
    probes: createFundedModelProbeService({ db, operator, credentials: repository,
      relayBaseUrl: env.MATRIX_FUNDED_AI_RELAY_URL, relayControlToken, ...loadFundedModelProbeLimits(env) }),
    relayRoutes: createAiFundedRelayRoutes({ repository, relayControlToken, operatorStore: operator?.store }),
  };
}
