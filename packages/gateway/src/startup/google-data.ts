import type { Kysely } from 'kysely';
import { isDeepStrictEqual } from 'node:util';
import type { BotRuntimeRegistry, PiRuntimeBinding } from '../bots/runtime-registry.js';
import type { BotIntegrationTransport } from '../bots/integration-client.js';
import { createGoogleContextStore } from '../google-data/runtime/contexts.js';
import { createGoogleRunPinStore } from '../google-data/runtime/run-pins.js';
import { createGooglePlatformPolicyClient } from '../google-data/runtime/platform-client.js';
import { createGoogleRuntimeInferenceAuthority } from '../google-data/runtime/runtime-authority.js';
import { GoogleInferenceIdentitySchema } from '../google-data/runtime/profile-resolution.js';
import type { GoogleDataInferenceAuthority, GoogleInferenceIdentity } from '../google-data/runtime/inference-policy.js';

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
  const authority = createGoogleRuntimeInferenceAuthority({ registry: options.registry, contexts, pins, policyClient });
  const observed = new Map<string, { binding: PiRuntimeBinding; identity: GoogleInferenceIdentity; signal: AbortSignal; expiresAt: number }>(); // <=64; TTL/LRU eviction and shutdown clear.
  const live = (binding: PiRuntimeBinding) => {
    const signal = options.registry.inferenceSignal(binding);
    return signal && !signal.aborted && isDeepStrictEqual(options.registry.lookupRun(binding), binding) ? signal : null;
  };
  const sweep = () => {
    for (const [key, value] of observed) if (value.expiresAt <= Date.now() || live(value.binding) !== value.signal) observed.delete(key);
  };
  const inference: GoogleDataInferenceAuthority = {
    async authorize(input) {
      const binding = structuredClone(input.binding);
      const candidate = input.identity === null ? null : structuredClone(input.identity);
      const result = await authority.authorize({ ...input, binding, identity: candidate });
      const signal = live(binding);
      const identity = GoogleInferenceIdentitySchema.safeParse(candidate);
      if (result.allowed && input.phase === 'dispatch' && signal && identity.success && !input.signal.aborted) {
        sweep();
        observed.delete(binding.runtimeHandle);
        if (observed.size >= 64) observed.delete(observed.keys().next().value!);
        observed.set(binding.runtimeHandle, { binding, identity: identity.data,
          signal, expiresAt: Date.now() + 20 * 60_000 });
      }
      return result;
    },
  };
  return { contexts, inference,
    /** Server-only observation, never profile approval or a replacement for a
     * fresh credential read/revalidation before collection. No credential value. */
    observedIdentity(binding: PiRuntimeBinding): GoogleInferenceIdentity | null {
      sweep(); const value = observed.get(binding.runtimeHandle);
      return value && isDeepStrictEqual(value.binding, binding) ? structuredClone(value.identity) : null;
    },
    start: () => pins.startCleanup(),
    async close() { observed.clear(); await pins.close(); },
  };
}
