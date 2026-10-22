import { z } from 'zod/v4';
import { discardGooglePolicyResponse } from './response-cleanup.js';
import type { BotIntegrationTransport } from '../../bots/integration-client.js';
import { GoogleDataConsentInputSchema } from '../profiles.js';
import { GooglePolicyDisclosureSchema } from './profile-resolution.js';

const OwnerProfile = GooglePolicyDisclosureSchema.extend({ connectionType: z.enum(['managed', 'byo']),
  consentRevision: z.number().int().min(0).max(2_147_483_646), consentActive: z.boolean() });
const Profiles = z.strictObject({ profiles: z.array(OwnerProfile).max(100) });
const Consent = GoogleDataConsentInputSchema.omit({ ownerId: true, googleAccountId: true }).extend({ connectionId: z.uuid(),
  accepted: z.literal(true), expectedConsentRevision: z.number().int().min(0).max(2_147_483_645) });
const Recorded = z.strictObject({ consentRevision: z.number().int().positive().max(2_147_483_646), consentActive: z.literal(true) });
export type GoogleOwnerProfileDisclosure = z.infer<typeof OwnerProfile>;
export type GoogleOwnerConsentInput = z.infer<typeof Consent>;
export class GoogleOwnerConsentError extends Error {
  constructor() { super('Google data settings unavailable'); this.name = 'GoogleOwnerConsentError'; }
}
const MAX_RESPONSE = 1_048_576;
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new GoogleOwnerConsentError());
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', stop); }
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) { discardGooglePolicyResponse(response); throw new GoogleOwnerConsentError(); }
  const reader = response.body.getReader(); const bytes = new Uint8Array(MAX_RESPONSE); let size = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal); if (part.done) break;
      if (part.value.byteLength + size > MAX_RESPONSE) throw new GoogleOwnerConsentError();
      bytes.set(part.value, size); size += part.value.byteLength;
    }
    if (signal.aborted) throw new GoogleOwnerConsentError();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    void reader.cancel().catch(cleanupError => console.warn('[google-data] Consent response cleanup:', cleanupError instanceof Error ? cleanupError.name : 'UnknownError'));
    throw error;
  } finally { reader.releaseLock(); }
}
/** Server-only fixed owner settings paths. Transport must supply verified owner delegation;
 * neither owner selection nor private provider facts are accepted from an HTTP/model payload. */
export function createGoogleOwnerConsentClient(transport: BotIntegrationTransport) {
  async function send(ownerId: string, method: 'GET' | 'POST', path: string, body?: GoogleOwnerConsentInput, signal?: AbortSignal) {
    if (!GoogleDataConsentInputSchema.shape.ownerId.safeParse(ownerId).success) throw new GoogleOwnerConsentError();
    const bounded = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
    if (bounded.aborted) throw new GoogleOwnerConsentError();
    const pending = transport(ownerId, { method, path, ...(body ? { body } : {}), signal: bounded });
    void pending.then(response => { if (bounded.aborted) discardGooglePolicyResponse(response); }, () => undefined);
    const response = await abortable(pending, bounded);
    return json(response, bounded);
  }
  return {
    async disclosures(ownerId: string, googleAccountId: string, signal?: AbortSignal): Promise<GoogleOwnerProfileDisclosure[]> {
      try {
        const account = z.uuid().parse(googleAccountId).toLowerCase();
        const parsed = Profiles.parse(await send(ownerId, 'GET', `/gmail/processing-profiles?connectionId=${encodeURIComponent(account)}`, undefined, signal));
        if (parsed.profiles.some(p => p.googleAccountId !== account)
          || new Set(parsed.profiles.map(p => p.profileId)).size !== parsed.profiles.length) throw new GoogleOwnerConsentError();
        return parsed.profiles;
      } catch (_error) { throw new GoogleOwnerConsentError(); }
    },
    async recordConsent(ownerId: string, value: GoogleOwnerConsentInput, signal?: AbortSignal) {
      try {
        const input = Consent.parse(value);
        if (Buffer.byteLength(JSON.stringify(input)) > 4096) throw new GoogleOwnerConsentError();
        const recorded = Recorded.parse(await send(ownerId, 'POST', '/gmail/processing-consents', input, signal));
        if (recorded.consentRevision !== input.expectedConsentRevision + 1) throw new GoogleOwnerConsentError();
        return recorded;
      } catch (_error) { throw new GoogleOwnerConsentError(); }
    },
  };
}
