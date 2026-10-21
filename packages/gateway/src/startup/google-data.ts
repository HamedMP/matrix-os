import type { Kysely } from 'kysely';
import type { BotRuntimeRegistry } from '../bots/runtime-registry.js';
import type { BotIntegrationTransport } from '../bots/integration-client.js';
import { createGoogleContextStore } from '../google-data/runtime/contexts.js';
import { createGoogleRunPinStore } from '../google-data/runtime/run-pins.js';
import { createGooglePlatformPolicyClient } from '../google-data/runtime/platform-client.js';
import { createGoogleRuntimeInferenceAuthority } from '../google-data/runtime/runtime-authority.js';

/** Owner database composition only. Missing platform transport denies classified
 * Google work. No profiles, consent or classification are invented at startup;
 * unknown saved history still requires admission before its content is read. */
export async function createGoogleBrokerRuntime<DB>(options: {
  database: Kysely<DB>; registry: BotRuntimeRegistry; transport?: BotIntegrationTransport;
}) {
  const contexts = createGoogleContextStore(options.database);
  const pins = createGoogleRunPinStore(options.database);
  await contexts.migrate();
  await pins.migrate();
  const transport: BotIntegrationTransport = options.transport ?? (async () => { throw new Error('Google policy transport unavailable'); });
  const policyClient = createGooglePlatformPolicyClient(transport);
  const inference = createGoogleRuntimeInferenceAuthority({ registry: options.registry, contexts, pins, policyClient });
  return { contexts, inference,
    start: () => pins.startCleanup(),
    close: () => pins.close(),
  };
}
