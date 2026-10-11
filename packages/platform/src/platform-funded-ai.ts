import { isDeepStrictEqual } from 'node:util';
import type { Hono } from 'hono';
import type { PlatformDB } from './db.js';
import { createAiFundedPolicyRepository, type AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { createAiFundedOperatorRoutes, createAiFundedRelayRoutes, createAiFundedRuntimeRoutes, loadAiFundedControlPlaneConfig } from './ai-funded-policy-routes.js';
import { loadAiCreditCheckoutConfig } from './ai-credit-checkout.js';
import { createFundedModelProbeService, loadFundedModelProbeLimits, type FundedModelProbeService } from './ai-funded-model-probes.js';
import { loadFundedAcceptanceScope, type FundedAcceptanceScope } from './ai-funded-acceptance-scope.js';
/** Focused extraction keeps funded composition behavior out of oversized startup.
* Acceptance is an additional restriction; canonical normal config is unchanged. */
export function createPlatformFundedAiComposition(input: {
  db: PlatformDB;
  platformSecret: string;
  env: NodeJS.ProcessEnv;
  acceptanceScope?: FundedAcceptanceScope;
}) {
  const { db, platformSecret, env } = input;
  const scope = loadFundedAcceptanceScope(env);
  if (!isDeepStrictEqual(scope, input.acceptanceScope))
    throw new Error('Funded acceptance composition is misconfigured');
  const config = loadAiFundedControlPlaneConfig({ ...env, PLATFORM_SECRET: platformSecret });
  let fundedAiRepository: AiFundedPolicyRepository | undefined;
  let fundedModelProbes: FundedModelProbeService | undefined;
  let internalFundedAiRuntimeRoutes: Hono | undefined;
  let internalFundedAiRelayRoutes: Hono | undefined;
  let internalFundedAiOperatorRoutes: Hono | undefined;
  if (config.enabled) {
    fundedAiRepository = createAiFundedPolicyRepository({
      db, acceptanceScope: scope,
      credentialHashSecret: config.credentialHashSecret, credentialTtlMs: config.credentialTtlMs,
      issueCooldownMs: config.issueCooldownMs, policyFreshnessMs: config.policyFreshnessMs
    });
    fundedModelProbes = createFundedModelProbeService({
      db, acceptanceScope: scope, credentials: fundedAiRepository,
      relayBaseUrl: env.MATRIX_FUNDED_AI_RELAY_URL, relayControlToken: config.relayControlToken,
      ...loadFundedModelProbeLimits(env)
    });
    internalFundedAiRuntimeRoutes = createAiFundedRuntimeRoutes({
      db, platformSecret: config.platformSecret,
      repository: fundedAiRepository, topUpEnabled: loadAiCreditCheckoutConfig(env).enabled,
      promotionalGrant: config.promotionalGrant, routeProbes: fundedModelProbes
    });
    internalFundedAiRelayRoutes = createAiFundedRelayRoutes({ relayControlToken: config.relayControlToken,
      repository: fundedAiRepository, cleanupEnabled: scope === undefined });
    if (!scope)
      internalFundedAiOperatorRoutes = createAiFundedOperatorRoutes({
        db, operatorSecret: config.platformSecret,
        repository: fundedAiRepository, promotionalGrant: config.promotionalGrant
      });
    console.log('[platform] Funded AI control plane enabled; relay activation remains disabled');
  }
  return {
    fundedAiRepository, fundedModelProbes, internalFundedAiRuntimeRoutes, internalFundedAiRelayRoutes, internalFundedAiOperatorRoutes
  };
}
