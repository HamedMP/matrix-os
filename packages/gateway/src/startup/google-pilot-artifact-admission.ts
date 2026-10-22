import { isManagedPiBinding, type BotRuntimeRegistry, type PiRuntimeBinding } from '../bots/runtime-registry.js';
import { createGooglePilotArtifactWriteFence } from '../google-data/runtime/pilot-artifact-writes.js';
/** The operator host flag covers every managed Pi run, including ordinary-before-taint.
 * Legacy recipe bindings stay under their existing source/tool policy outside this pilot. */
export function createGooglePilotArtifactAdmission(registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>) {
  const fence = createGooglePilotArtifactWriteFence(registry);
  return Object.freeze({ async assertAllowed(binding: PiRuntimeBinding, signal: AbortSignal): Promise<void> {
    if (isManagedPiBinding(binding)) await fence.assertAllowed(binding, signal);
  } });
}
