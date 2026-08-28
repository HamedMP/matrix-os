import { ClientPolicyResponseSchema, type ClientPolicyResponse, type ClientTarget } from '#client-policy';

export function createClientPolicyReader(options: {
  target: ClientTarget;
  fetchFn?: (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Pick<Response, 'ok' | 'body'>>;
  load?: () => Promise<{ origin: string; response: ClientPolicyResponse } | null>;
  save?: (value: { origin: string; response: ClientPolicyResponse }) => Promise<void>;
}) {
  // A single entry, replaced on origin changes: no unbounded client cache.
  let cached: { origin: string; response: ClientPolicyResponse } | null = null;
  let loading: Promise<void> | undefined;
  let activeOrigin: string | undefined;
  let inFlight: { origin: string; promise: Promise<ClientPolicyResponse> } | null = null;
  async function read(origin: string): Promise<ClientPolicyResponse> {
    const normalized = new URL(origin).origin;
    activeOrigin = normalized;
    if (inFlight?.origin === normalized) return inFlight.promise;
    const promise: Promise<ClientPolicyResponse> = (async () => {
      loading ??= (async () => {
        try {
          const stored = await options.load?.();
          if (stored && new URL(stored.origin).origin === activeOrigin) cached = { origin: activeOrigin, response: ClientPolicyResponseSchema.parse(stored.response) };
        } catch (err: unknown) { console.warn('[client-policy] Cached policy unavailable', err instanceof Error ? err.name : typeof err); }
      })();
      await loading;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const url = new URL('/client-policy', normalized);
        url.searchParams.set('target', options.target);
        const signal = typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) : controller.signal;
        const response = await (options.fetchFn ?? fetch)(url.toString(), { signal, redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Policy unavailable'); }
        let text = '';
        // Mobile injects expo/fetch. Never buffer an unbounded native text body
        // when streaming is unavailable; retain the last validated policy instead.
        if (!response.body?.getReader) throw new Error('Streaming policy response required');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 8192) { await reader.cancel(); throw new Error('Oversized policy'); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        const validated = ClientPolicyResponseSchema.parse(JSON.parse(text));
        if (cached?.origin === normalized && validated.revision < cached.response.revision) return cached.response;
        // An old origin's delayed response must not evict the current runtime's
        // known minimum while the user switches computers.
        if (activeOrigin === normalized) {
          cached = { origin: normalized, response: validated };
          await options.save?.(cached);
        }
        return validated;
      } catch (err: unknown) {
        console.warn('[client-policy] Policy check unavailable', err instanceof Error ? err.name : typeof err);
        return cached?.origin === normalized ? cached.response : { schemaVersion: 1 as const, revision: 0, policy: null };
      } finally { controller.abort(); clearTimeout(timeout); }
    })();
    inFlight = { origin: normalized, promise };
    try { return await promise; } finally { if (inFlight?.promise === promise) inFlight = null; }
  }
  return { read };
}
