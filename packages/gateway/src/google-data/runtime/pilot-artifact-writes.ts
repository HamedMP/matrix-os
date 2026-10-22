import { isDeepStrictEqual } from 'node:util';
import { BotBrokerActionError } from '../../bots/broker-actions.js';
import { isManagedPiBinding, type BotRuntimeRegistry, type PiRuntimeBinding } from '../../bots/runtime-registry.js';

/** Install ONLY for an owner host admitted by server-owned Google pilot configuration.
 * Birth, context absence, permission mode and request fields are not pilot admission.
 * Refusing the whole capability before any body staging avoids untracked filesystem
 * copies. Owner uploads/exports use separate routes. No file deletion or pool ownership.
 * Other managed runs must use their ordinary dispatcher, without this pilot policy. */
export function createGooglePilotArtifactWriteFence(registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>) {
  return Object.freeze({
    async assertAllowed(binding: PiRuntimeBinding, signal: AbortSignal): Promise<never> {
      const lifetime = isManagedPiBinding(binding) ? registry.inferenceSignal(binding) : null;
      if (signal.aborted || !isManagedPiBinding(binding)
        || !isDeepStrictEqual(registry.lookupRun(binding), binding)
        || !lifetime || lifetime.aborted) {
        throw new BotBrokerActionError('not_granted');
      }
      // Google-derived file storage has no qualified retention/deletion adapter.
      // An ordinary pilot run may collect Gmail later, so taint is not the selector.
      throw new BotBrokerActionError('not_granted');
    },
  });
}
