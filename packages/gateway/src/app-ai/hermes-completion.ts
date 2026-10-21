import { AppAiInputSchema } from '@matrix-os/contracts';
import type { AgentRuntimeSource } from '../agent-config/service.js';
import { createGenericNativeWriter } from '../ai-providers/generic-native-writer.js';
import { proveHermesAppCredential, type HermesAppSelection } from './hermes-credential-proof.js';
import { completeHermesHttp, HermesAppUndrainedError } from './hermes-http.js';

/** No agent/session/tools, copied rotating profile, credential refresh or fallback. */
export function createHermesAppCompletion(options: { homePath: string; runtimeSource: AgentRuntimeSource; fetchImpl?: typeof fetch }) {
  const writer = createGenericNativeWriter(options.homePath); let closed = false;
  let active: { controller: AbortController; operation: Promise<unknown> } | undefined;
  async function admitted<T>(input: HermesAppSelection, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    input.signal.throwIfAborted(); if (closed || active) throw new Error('App AI native profile unavailable');
    const controller = new AbortController(); const signal = AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(30000)]);
    const pending = (async () => {
      const release = await writer.acquire('hermes');
      let undrained=false;
      try { signal.throwIfAborted(); return await operation(signal); }
      catch(error){undrained=error instanceof HermesAppUndrainedError;throw error;}
      finally { if(!undrained)await release(); }
    })();
    active = { controller, operation: pending };
    try { return await pending; }
    finally { if (active?.operation === pending) active = undefined; }
  }
  return {
    async probe(input: HermesAppSelection): Promise<boolean> {
      try { return await admitted(input, async signal => { await proveHermesAppCredential({ ...input, ...options, signal }); return true; }); }
      catch (error) { input.signal.throwIfAborted(); console.warn('[app-ai] Hermes discovery unavailable', error instanceof Error ? error.name : 'UnknownError'); return false; }
    },
    async generate(input: HermesAppSelection & { prompt: string; revalidate: () => Promise<boolean> }) {
      const { prompt } = AppAiInputSchema.parse({ prompt: input.prompt });
      return admitted(input, async signal => {
        const proof = await proveHermesAppCredential({ ...input, ...options, signal });
        if (!await input.revalidate()) throw new Error('App AI access revoked');
        signal.throwIfAborted(); await proof.unchanged();
        const result = await completeHermesHttp({ proof, prompt, signal, fetchImpl: options.fetchImpl });
        await proof.live(); if (!await input.revalidate()) throw new Error('App AI access revoked');
        signal.throwIfAborted(); return result;
      });
    },
    async close() {
      closed = true; const pending = active; if (!pending) return;
      pending.controller.abort(); let timer: ReturnType<typeof setTimeout> | undefined;
      // The request retains its durable fence until actual work drains, even if shutdown stops waiting.
      try { await Promise.race([pending.operation.catch(error => console.warn('[app-ai] Hermes shutdown cancellation', error instanceof Error ? error.name : 'UnknownError')), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
