import { isDeepStrictEqual } from 'node:util';
import type { BotRuntimeRegistry, PiRuntimeBinding } from '../../bots/runtime-registry.js';
import type { GoogleContextStore } from './contexts.js';

export class GoogleToolEgressError extends Error {
  constructor() { super('Tool unavailable'); this.name = 'GoogleToolEgressError'; }
}
function deny(): never { throw new GoogleToolEgressError(); }

/** Server-only refusal boundary for onward adapters without reviewed Google-data
 * recipient support. Every durable marker denies, including expired/deleted ones.
 * Null permits only the current ordinary run; it does NOT qualify unknown saved
 * history, imports or referenced content. Hosts must classify those before use.
 * Call immediately before each dispatch. No approval cache or pool ownership. */
export function createGoogleToolEgressGuard(deps: {
  registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>;
  contexts: Pick<GoogleContextStore, 'inspect'>;
}) {
  if (![deps?.registry?.lookupRun, deps?.registry?.inferenceSignal, deps?.contexts?.inspect].every(value => typeof value === 'function')) deny();
  return {
    async assertAllowed(bindingValue: PiRuntimeBinding, callerSignal: AbortSignal): Promise<void> {
      try {
        const binding = structuredClone(bindingValue);
        const lifetime = deps.registry.inferenceSignal(binding);
        if (!lifetime) deny();
        const signal = AbortSignal.any([callerSignal, lifetime, AbortSignal.timeout(10000)]);
        const current = () => {
          if (signal.aborted || !isDeepStrictEqual(deps.registry.lookupRun(binding), binding)
            || deps.registry.inferenceSignal(binding) !== lifetime) deny();
        };
        current();
        let abort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new GoogleToolEgressError());
          signal.addEventListener('abort', abort, { once: true });
        });
        try {
          // Attach the cancellation race before invoking even a synchronous fake
          // or failing dependency. A late result cannot grant tool authority.
          const reading = Promise.resolve().then(() => { current(); return deps.contexts.inspect(binding.ownerId, binding.chatId); });
          const context = await Promise.race([reading, aborted]);
          current();
          if (context !== null) deny();
        } finally { signal.removeEventListener('abort', abort); }
      } catch (error: unknown) {
        if (error instanceof GoogleToolEgressError) throw error;
        // Dependency diagnostics can contain content or infrastructure details.
        // Retain neither their message nor a cause at this boundary.
        throw new GoogleToolEgressError();
      }
    },
  };
}
