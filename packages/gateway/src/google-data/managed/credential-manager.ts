import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { GOOGLE_QUALIFIED_FUNDED_PROTOCOL, MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN, serializeManagedGoogleRouteDescriptor,
  GoogleQualifiedFundedDiscoveryRequestSchema, GoogleQualifiedFundedDiscoveryResponseSchema,
  GoogleQualifiedFundedIssueRequestSchema, GoogleQualifiedFundedIssueResponseSchema,
  type GoogleQualifiedFundedRoute, type GoogleQualifiedFundedBinding, type FundedAiRequestClass } from '@matrix-os/contracts';
import type { FundedAiRuntimeConfig } from '../../funded-ai-credential-manager.js';

export class GoogleQualifiedCredentialError extends Error { constructor() { super('Qualified AI unavailable'); this.name = 'GoogleQualifiedCredentialError'; } }
const deny = (): never => { throw new GoogleQualifiedCredentialError(); };
const protocol = GOOGLE_QUALIFIED_FUNDED_PROTOCOL;
interface Selector { api: 'openai-completions'; canonicalModelId: string }
export interface GoogleQualifiedCredentialLease {
  token: string; tokenId: string; expiresAt: string; relayBaseUrl: string; maxRunMs: number;
  requestClass: FundedAiRequestClass; binding: GoogleQualifiedFundedBinding;
}
export interface GoogleQualifiedCredentialManager {
  readonly identity: Readonly<FundedAiRuntimeConfig['identity']>;
  resolveRoute(selector: Selector, signal?: AbortSignal): Promise<GoogleQualifiedFundedRoute>;
  getCredential(options: Selector & { requestClass: FundedAiRequestClass; minValidityMs?: number; signal?: AbortSignal }): Promise<GoogleQualifiedCredentialLease>;
  invalidate(tokenId?: string): void;
  close(): Promise<void>;
}

/** Separate exact lease cache; never shares legacy entries, requests or fallback behavior. At most32 cached
 * routes (LRU/expiry sweep),4 independent active operations; caller cancellation never owns another call. */
export function createGoogleQualifiedCredentialManager(input: FundedAiRuntimeConfig,
  dependencies: { fetchFn?: typeof fetch; now?: () => number } = {}): GoogleQualifiedCredentialManager {
  const config = structuredClone(input); const fetchFn = dependencies.fetchFn ?? fetch; const now = dependencies.now ?? Date.now;
  let issue: URL; let relay: URL;
  try { issue = new URL(config.issueUrl); relay = new URL(config.relayBaseUrl); } catch (error) { return deny(); }
  if (issue.protocol !== 'https:' || issue.username || issue.password || issue.hash
    || !/^\/internal\/containers\/[a-z0-9][a-z0-9-]{0,62}\/ai\/funded-credential$/.test(issue.pathname)
    || issue.searchParams.size !== 1 || issue.searchParams.get('runtimeSlot') !== config.identity.runtimeSlot
    || relay.protocol !== 'https:' || relay.username || relay.password || relay.search || relay.hash
    || relay.href.replace(/\/$/, '') !== config.relayBaseUrl || !/^[A-Za-z0-9._~+/=-]{32,512}$/.test(config.runtimeAuthToken)
    || !Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 500 || config.requestTimeoutMs > 10000
    || !Number.isInteger(config.maxRunMs) || config.maxRunMs < 1000 || config.maxRunMs > 600000) deny();
  const discoveryUrl = new URL(issue); discoveryUrl.pathname = issue.pathname.replace('/ai/funded-credential', '/ai/qualified/managed-route');
  const issueUrl = new URL(issue); issueUrl.pathname = issue.pathname.replace('/ai/funded-credential', '/ai/qualified/funded-credential');
  const cached = new Map<string, GoogleQualifiedCredentialLease>();
  const active = new Set<AbortController>(); let closed = false; let revision = 0;
  let drained = Promise.resolve(); let finish: (() => void) | undefined; let closing: Promise<void> | undefined;
  const sweep = () => { for (const [key, value] of cached) if (Date.parse(value.expiresAt) <= now()) cached.delete(key); };
  const timer = setInterval(sweep, 30000); timer.unref?.();
  async function bounded<T>(parent: AbortSignal | undefined, work: (signal: AbortSignal, live: () => void) => Promise<T>): Promise<T> {
    if (closed || active.size >= 4) deny(); sweep(); const generation = revision;
    const controller = new AbortController(); if (!active.size) drained = new Promise(resolve => { finish = resolve; }); active.add(controller);
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs); timeout.unref?.();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const live = () => { if (closed || signal.aborted || generation !== revision || !Number.isSafeInteger(now())) deny(); };
    try { live(); const result = await work(signal, live); live(); return result; }
    catch (error) { if (error instanceof GoogleQualifiedCredentialError) throw error; throw new GoogleQualifiedCredentialError(); }
    finally { clearTimeout(timeout); active.delete(controller); if (!active.size) { finish?.(); finish = undefined; } }
  }
  async function call<T>(url: URL, value: unknown, schema: z.ZodType<T>, signal: AbortSignal, live: () => void): Promise<T> {
    live(); const body = JSON.stringify(value); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => { stop = () => reject(new GoogleQualifiedCredentialError()); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
    try {
      const pending = fetchFn(url.toString(), { method: 'POST', body, redirect: 'error', signal,
        headers: { authorization: `Bearer ${config.runtimeAuthToken}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }).then(response => {
          if (signal.aborted || closed) { void response.body?.cancel().catch(() => console.warn('[qualified-credentials] Late body cleanup failed')); return deny(); } return response;
        });
      const response = await Promise.race([pending, stopped]);
      reader = response.body?.getReader(); live();
      if (!response.ok || !reader || Number(response.headers.get('content-length') ?? 0) > 65536) deny();
      const bodyReader = reader; if (!bodyReader) return deny();
      const bytes = new Uint8Array(65536); let size = 0; let chunks = 0;
      for (;;) { const part = await Promise.race([bodyReader.read(), stopped]); live(); if (part.done) break;
        if (++chunks > 256 || size + part.value.length > bytes.length) deny(); bytes.set(part.value, size); size += part.value.length; }
      return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
    } catch (error) {
      if (reader) await reader.cancel().catch(() => console.warn('[qualified-credentials] Body cleanup failed'));
      if (!(error instanceof GoogleQualifiedCredentialError) && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)
        && !(error instanceof TypeError)) console.warn('[qualified-credentials] Unexpected response failure', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' });
      throw new GoogleQualifiedCredentialError();
    }
    finally { signal.removeEventListener('abort', stop); reader?.releaseLock(); }
  }
  function validRoute(route: GoogleQualifiedFundedRoute) {
    const digest = createHash('sha256').update(MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN).update(serializeManagedGoogleRouteDescriptor(route.descriptor)).digest('hex');
    if (route.digest !== digest || route.relayBaseUrl !== config.relayBaseUrl || now() < Date.parse(route.descriptor.evidence.reviewedAt)
      || now() >= Date.parse(route.evidenceExpiresAt)) deny();
  }
  async function discover(selector: Selector, signal: AbortSignal, live: () => void) {
    const request = GoogleQualifiedFundedDiscoveryRequestSchema.parse({ protocol, api: selector.api, canonicalModelId: selector.canonicalModelId });
    const result = await call(discoveryUrl, request, GoogleQualifiedFundedDiscoveryResponseSchema, signal, live); live(); validRoute(result.route);
    if (result.route.api !== selector.api || result.route.canonicalModelId !== selector.canonicalModelId) deny(); return result.route;
  }
  return {
    identity: Object.freeze({ ...config.identity }),
    resolveRoute(selector, signal) { return bounded(signal, (current, live) => discover(selector, current, live)); },
    getCredential(options) { return bounded(options.signal, async (signal, live) => {
      const minValidity = Math.max(options.minValidityMs ?? config.maxRunMs + 60000, 60000);
      if (!Number.isSafeInteger(minValidity) || minValidity > 3600000) deny();
      const route = await discover(options, signal, live);
      const request = GoogleQualifiedFundedIssueRequestSchema.parse({ protocol, api: route.api, canonicalModelId: route.canonicalModelId,
        expectedDigest: route.digest, requestClass: options.requestClass });
      const key = JSON.stringify([request.api, request.canonicalModelId, request.requestClass, request.expectedDigest]);
      const existing = cached.get(key);
      if (existing && Date.parse(existing.expiresAt) - now() >= minValidity) {
        cached.delete(key); cached.set(key, existing); return structuredClone(existing);
      }
      cached.delete(key);
      const result = await call(issueUrl, request, GoogleQualifiedFundedIssueResponseSchema, signal, live); live(); validRoute(result.binding);
      if (result.lease.identity.ownerId !== config.identity.ownerId || result.lease.identity.machineId !== config.identity.machineId
        || result.lease.identity.runtimeSlot !== config.identity.runtimeSlot || result.lease.requestClass !== request.requestClass
        || result.binding.requestClass !== request.requestClass || result.binding.digest !== route.digest
        || JSON.stringify(result.binding.descriptor) !== JSON.stringify(route.descriptor)
        || result.binding.api !== route.api || result.binding.canonicalModelId !== route.canonicalModelId
        || Date.parse(result.lease.credential.issuedAt) > now() || Date.parse(result.lease.credential.expiresAt) - now() < minValidity) deny();
      const lease: GoogleQualifiedCredentialLease = { token: result.lease.credential.token, tokenId: result.lease.credential.tokenId,
        expiresAt: result.lease.credential.expiresAt, relayBaseUrl: result.binding.relayBaseUrl, maxRunMs: config.maxRunMs,
        requestClass: result.lease.requestClass, binding: result.binding };
      if (cached.size >= 32) cached.delete(cached.keys().next().value!); cached.set(key, lease); return structuredClone(lease);
    }); },
    invalidate(tokenId) { revision++; for (const [key, value] of cached) if (!tokenId || value.tokenId === tokenId) cached.delete(key); },
    close() { if (!closing) { closed = true; revision++; clearInterval(timer); cached.clear(); for (const controller of active) controller.abort(); closing = drained; } return closing; },
  };
}
