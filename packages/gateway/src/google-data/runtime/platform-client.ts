import { discardGooglePolicyResponse } from './response-cleanup.js';
import type { BotIntegrationTransport } from '../../bots/integration-client.js';
import { GooglePolicyAuthorizeSchema, GooglePolicyConsentRequiredSchema, GooglePolicyGrantedSchema, GooglePolicyRevalidateSchema, matchesGoogleObservedRoute } from './profile-resolution.js';
import { routeDigest } from '../profiles.js';
import type { z } from 'zod/v4';
export class GooglePlatformPolicyError extends Error { constructor() { super('Google data processing unavailable'); this.name = 'GooglePlatformPolicyError'; } }
const MAX_RESPONSE = 65536;
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.race([Promise.reject(new GooglePlatformPolicyError()), promise]);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new GooglePlatformPolicyError()); signal.addEventListener('abort', rejectAbort, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', rejectAbort); }
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) { discardGooglePolicyResponse(response); throw new GooglePlatformPolicyError(); }
  const reader = response.body.getReader(); const bytes = new Uint8Array(MAX_RESPONSE); let size = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal); if (part.done) break;
      if (size + part.value.byteLength > MAX_RESPONSE) throw new GooglePlatformPolicyError();
      bytes.set(part.value, size); size += part.value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    void reader.cancel().catch(cleanupError => console.warn('[google-data] Policy response cleanup:', cleanupError instanceof Error ? cleanupError.name : 'UnknownError'));
    throw error;
  } finally { reader.releaseLock(); }
}
export type GooglePolicyClientResult = ({ status: 'authorized' } & z.infer<typeof GooglePolicyGrantedSchema>)
  | ({ status: 'consent_required' } & Omit<z.infer<typeof GooglePolicyConsentRequiredSchema>, 'error'>);
/** Server-only fixed internal paths. Returned route/account evidence must never
 * be passed to a model. The transport authenticates machine and signs the owner. */
export function createGooglePlatformPolicyClient(transport: BotIntegrationTransport) {
  async function send(ownerId: string, action: 'authorize' | 'revalidate', value: unknown, signal?: AbortSignal): Promise<GooglePolicyClientResult> {
    try {
      const parsed = (action === 'authorize' ? GooglePolicyAuthorizeSchema : GooglePolicyRevalidateSchema).safeParse(value);
      if (!parsed.success || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(ownerId)) throw new GooglePlatformPolicyError();
      const bounded = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
      if (bounded.aborted) throw new GooglePlatformPolicyError();
      const pending = transport(ownerId, { method: 'POST', path: `/gmail/processing/${action}`, body: parsed.data, signal: bounded });
      void pending.then(response => { if (bounded.aborted) discardGooglePolicyResponse(response); }, () => undefined);
      const response = await abortable(pending, bounded);
      if (response.status !== 200 && !(action === 'authorize' && response.status === 428)) { discardGooglePolicyResponse(response); throw new GooglePlatformPolicyError(); }
      const body = await readJson(response, bounded);
      if (response.status === 428) {
        const required = GooglePolicyConsentRequiredSchema.parse(body);
        if (required.disclosure.googleAccountId !== parsed.data.googleAccountId || required.disclosure.purposeId !== parsed.data.purposeId
          || JSON.stringify(required.disclosure.dataKinds) !== JSON.stringify(parsed.data.dataKinds)) throw new GooglePlatformPolicyError();
        return { status: 'consent_required', disclosure: required.disclosure, consentRevision: required.consentRevision };
      }
      const granted = GooglePolicyGrantedSchema.parse(body);
      if (granted.stamp.ownerId !== ownerId || granted.stamp.googleAccountId !== parsed.data.googleAccountId || granted.stamp.purposeId !== parsed.data.purposeId
        || !matchesGoogleObservedRoute(granted.resolvedRoute, parsed.data.identity)
        || JSON.stringify(granted.stamp.dataKinds) !== JSON.stringify(parsed.data.dataKinds) || granted.stamp.routeDigest !== routeDigest(granted.resolvedRoute)
        || action === 'revalidate' && JSON.stringify(granted.stamp) !== JSON.stringify(GooglePolicyRevalidateSchema.parse(parsed.data).stamp)) throw new GooglePlatformPolicyError();
      return { status: 'authorized', ...granted };
    } catch (error) { if (error instanceof GooglePlatformPolicyError) throw error; throw new GooglePlatformPolicyError(); }
  }
  return {
    authorize: (ownerId: string, input: unknown, signal?: AbortSignal) => send(ownerId, 'authorize', input, signal),
    async revalidate(ownerId: string, input: unknown, signal?: AbortSignal) {
      const result = await send(ownerId, 'revalidate', input, signal);
      if (result.status !== 'authorized') throw new GooglePlatformPolicyError();
      return { stamp: result.stamp, resolvedRoute: result.resolvedRoute };
    },
  };
}
