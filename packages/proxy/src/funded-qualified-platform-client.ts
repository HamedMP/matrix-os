import { FundedAiSafeErrorSchema, GoogleQualifiedFundedAuthorizationRequestSchema, GoogleQualifiedFundedAuthorizationResponseSchema,
  GoogleQualifiedFundedDispatchCheckRequestSchema, GoogleQualifiedFundedDispatchCheckResponseSchema } from '@matrix-os/contracts';
import type { z } from 'zod/v4';
import { normalizeFundedPlatformOrigin, type FundedRelayConfig } from './funded-relay-config.js';
import { FundedControlPlaneError } from './funded-relay-platform-client.js';

/** Separate wire protocol, no fallback to legacy endpoints. Only a fixed service-control origin/token. */
export function createQualifiedFundedPlatformClient(options: Pick<FundedRelayConfig,
  'platformBaseUrl' | 'relayControlToken' | 'platformTimeoutMs' | 'maxControlResponseBytes'> & { fetch: typeof fetch }) {
  const origin = normalizeFundedPlatformOrigin(options.platformBaseUrl);
  async function call<T>(action: 'authorize' | 'dispatch-check', body: unknown, schema: z.ZodType<T>, parent: AbortSignal): Promise<T> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.platformTimeoutMs); timer.unref?.();
    const signal = AbortSignal.any([parent, controller.signal]); const encoded = JSON.stringify(body);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new FundedControlPlaneError(503)); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    try {
      signal.throwIfAborted();
      const pending = options.fetch(`${origin}/internal/ai/funded/qualified/${action}`, { method: 'POST', signal: signal,
        headers: { authorization: `Bearer ${options.relayControlToken}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) },
        body: encoded, redirect: 'error' }).then(async response => {
          if (signal.aborted) { await response.body?.cancel().catch(cleanup => console.warn('[qualified-relay] Late body cleanup:', cleanup instanceof Error ? 'operation_failed' : 'untyped_failure')); throw new FundedControlPlaneError(503); }
          return response;
        });
      const response = await Promise.race([pending, stopped]);
      signal.throwIfAborted(); const cap = Math.min(65536, options.maxControlResponseBytes);
      reader = response.body?.getReader(); if (!reader || Number(response.headers.get('content-length') ?? 0) > cap) throw new FundedControlPlaneError(503);
      const bytes = new Uint8Array(cap); let size = 0; let count = 0;
      for (;;) { const part = await Promise.race([reader.read(), stopped]); if (part.done) break;
        if (++count > 256 || size + part.value.length > cap) throw new FundedControlPlaneError(503); bytes.set(part.value, size); size += part.value.length; }
      signal.throwIfAborted();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
      if (!response.ok) {
        // Only this authenticated authorization endpoint may report a safe
        // pre-dispatch priority refusal. Other 429s never grant retries.
        if (action === 'authorize' && response.status === 429) {
          const safe = FundedAiSafeErrorSchema.safeParse(JSON.parse(text));
          if (safe.success && safe.data.error.code === 'rate_limited' && safe.data.error.reason) {
            throw new FundedControlPlaneError(429, safe.data.error.reason);
          }
        }
        throw new FundedControlPlaneError(response.status === 401 ? 401 : 503);
      }
      return schema.parse(JSON.parse(text));
    } catch (error) {
      controller.abort(); if (reader) await reader.cancel().catch(cleanup => console.warn('[qualified-relay] Body cleanup:', cleanup instanceof Error ? 'operation_failed' : 'untyped_failure'));
      if (error instanceof FundedControlPlaneError) throw error; throw new FundedControlPlaneError(503);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); reader?.releaseLock(); }
  }
  return {
    check(input: z.input<typeof GoogleQualifiedFundedDispatchCheckRequestSchema>, signal: AbortSignal) {
      return call('dispatch-check', GoogleQualifiedFundedDispatchCheckRequestSchema.parse(input), GoogleQualifiedFundedDispatchCheckResponseSchema, signal);
    },
    authorize(input: z.input<typeof GoogleQualifiedFundedAuthorizationRequestSchema>, signal: AbortSignal) {
      return call('authorize', GoogleQualifiedFundedAuthorizationRequestSchema.parse(input), GoogleQualifiedFundedAuthorizationResponseSchema, signal);
    },
  };
}
