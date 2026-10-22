import { MANAGED_GOOGLE_ROUTE_CONTROL_PATH, ManagedGoogleRouteResolveRequestSchema, ManagedGoogleRouteResolveResponseSchema,
  GoogleQualifiedFundedRouteSchema, type ManagedGoogleRouteResolveRequest, type GoogleQualifiedFundedRoute } from '@matrix-os/contracts';
import { googleQualifiedRouteDigest } from './ai-funded-route-binding.js';
import { QualifiedFundedError } from './ai-funded-qualified-errors.js';

/** Operator-only endpoint; owner/model/body fields never select this origin or credentials. */
export function createFundedManagedRouteClient(options: { relayBaseUrl: string; controlToken: string; fetchFn?: typeof fetch; now?: () => Date }) {
  let base: URL;
  try { base = new URL(options.relayBaseUrl); } catch (error) { throw new QualifiedFundedError(); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || base.href.replace(/\/$/, '') !== options.relayBaseUrl || !/^[\x21-\x7e]{32,4096}$/.test(options.controlToken)) throw new QualifiedFundedError();
  const endpoint = new URL(MANAGED_GOOGLE_ROUTE_CONTROL_PATH, base).href; const fetchFn = options.fetchFn ?? fetch;
  return { async resolve(input: ManagedGoogleRouteResolveRequest, parentSignal: AbortSignal): Promise<GoogleQualifiedFundedRoute> {
    const parsed = ManagedGoogleRouteResolveRequestSchema.safeParse(input); if (!parsed.success) throw new QualifiedFundedError();
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]); const body = JSON.stringify(parsed.data);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new QualifiedFundedError()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    try {
      signal.throwIfAborted();
      const fetched = fetchFn(endpoint, { method: 'POST', redirect: 'error', signal, body,
        headers: { authorization: `Bearer ${options.controlToken}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }).then(response => {
          if (signal.aborted) { void response.body?.cancel().catch(error => console.warn('[qualified-route] Late cleanup:', error instanceof Error ? error.name : 'UnknownError')); throw new QualifiedFundedError(); }
          return response;
        });
      const response = await Promise.race([fetched, stopped]);
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 65536) { void response.body?.cancel().catch(error => console.warn('[qualified-route] Cleanup:', error instanceof Error ? error.name : 'UnknownError')); throw new QualifiedFundedError(); }
      reader = response.body.getReader(); const bytes = new Uint8Array(65536); let size = 0; let count = 0;
      for (;;) { const part = await Promise.race([reader.read(), stopped]); if (part.done) break;
        if (++count > 64 || size + part.value.length > bytes.length) throw new QualifiedFundedError(); bytes.set(part.value, size); size += part.value.length; }
      signal.throwIfAborted();
      const result = ManagedGoogleRouteResolveResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
      const route = GoogleQualifiedFundedRouteSchema.parse({ ...result, relayBaseUrl: options.relayBaseUrl, api: parsed.data.api,
        canonicalModelId: parsed.data.canonicalModelId, evidenceExpiresAt: result.descriptor.evidence.expiresAt });
      const at = (options.now?.() ?? new Date()).getTime();
      if (googleQualifiedRouteDigest(route.descriptor) !== route.digest || at < Date.parse(route.descriptor.evidence.reviewedAt)
        || at >= Date.parse(route.evidenceExpiresAt)) throw new QualifiedFundedError();
      return route;
    } catch (error) {
      if (reader) void reader.cancel().catch(cleanup => console.warn('[qualified-route] Cleanup:', cleanup instanceof Error ? cleanup.name : 'UnknownError'));
      throw new QualifiedFundedError();
    } finally { signal.removeEventListener('abort', abort); reader?.releaseLock(); }
  } };
}
