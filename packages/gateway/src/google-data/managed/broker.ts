import { isDeepStrictEqual } from 'node:util';
import type { BotRuntimeRegistry, PiRuntimeBinding } from '../../bots/runtime-registry.js';
import type { GoogleContextStore } from '../runtime/contexts.js';
import { GoogleInferencePolicyError, type GoogleInferenceIdentity } from '../runtime/inference-policy.js';
import { googleManagedInferenceIdentity } from './identity.js';
import type { GoogleQualifiedCredentialManager, GoogleQualifiedCredentialLease } from './credential-manager.js';

export interface GoogleManagedBrokerTransport {
  required(binding: PiRuntimeBinding, signal: AbortSignal): Promise<boolean>;
  acquire(binding: PiRuntimeBinding, signal: AbortSignal): Promise<{ lease: GoogleQualifiedCredentialLease; identity: GoogleInferenceIdentity }>;
}
/** Registry and durable contexts alone classify the run. A null context does not qualify unknown saved
 * history: host history admission remains mandatory. No payload flag, provider label or token hash. */
export function createGoogleManagedBrokerTransport(options: { registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>;
  contexts: Pick<GoogleContextStore, 'inspect'>; credentials?: GoogleQualifiedCredentialManager; lifetime: AbortSignal }) {
  const deny = (): never => { throw new GoogleInferencePolicyError(); };
  async function checked<T>(bindingValue: PiRuntimeBinding, parent: AbortSignal, work: (binding: PiRuntimeBinding, signal: AbortSignal) => Promise<T>): Promise<T> {
    const binding = structuredClone(bindingValue); const lifetime = options.registry.inferenceSignal(binding); if (!lifetime) return deny();
    const signal = AbortSignal.any([parent, lifetime, options.lifetime, AbortSignal.timeout(10000)]);
    const live = () => { if (signal.aborted || options.registry.inferenceSignal(binding) !== lifetime || !isDeepStrictEqual(options.registry.lookupRun(binding), binding)) deny(); };
    let stop!: () => void; const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new GoogleInferencePolicyError()); signal.addEventListener('abort', stop, { once: true }); });
    try { live(); const value = await Promise.race([work(binding, signal), aborted]); live(); return value; }
    finally { signal.removeEventListener('abort', stop); }
  }
  const manager = (binding: PiRuntimeBinding) => {
    if (binding.accessSourceId !== 'matrix_included' || binding.route.api !== 'openai-completions' || binding.subscription || binding.anthropicApi
      || !options.credentials || options.credentials.identity.ownerId !== binding.ownerId) return deny();
    return options.credentials;
  };
  return {
    required(binding: PiRuntimeBinding, signal: AbortSignal) { return checked(binding, signal, async current => {
      const context = await options.contexts.inspect(current.ownerId, current.chatId);
      if (context && (context.ownerId !== current.ownerId || context.chatId !== current.chatId)) return deny();
      return context !== null;
    }); },
    async resolveIdentity(binding: PiRuntimeBinding, signal: AbortSignal) { return checked(binding, signal, async (current, bounded) => {
      const route = await manager(current).resolveRoute({ api: 'openai-completions', canonicalModelId: current.route.modelId }, bounded);
      return googleManagedInferenceIdentity(current, route);
    }); },
    acquire(binding: PiRuntimeBinding, signal: AbortSignal) { return checked(binding, signal, async (current, bounded) => {
      const lease = await manager(current).getCredential({ api: 'openai-completions', canonicalModelId: current.route.modelId, requestClass: current.requestClass, signal: bounded });
      if (lease.requestClass !== current.requestClass || lease.binding.requestClass !== current.requestClass) return deny();
      const { requestClass: _class, ...route } = lease.binding; const identity = googleManagedInferenceIdentity(current, route);
      return { lease, identity };
    }); },
  };
}
