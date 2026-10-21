import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { BotRuntimeRegistry, PiRuntimeBinding } from '../../bots/runtime-registry.js';
import { GoogleDataKindsSchema, GoogleDataStampSchema, type GoogleDataStamp } from '../profiles.js';
import { googleContextOriginId, type GoogleContext, type GoogleContextStore } from './contexts.js';
import type { GoogleProcessingClaim } from './envelope.js';
import type { GoogleInferenceIdentity } from './inference-policy.js';
import type { createGoogleOwnerConsentClient, GoogleOwnerProfileDisclosure } from './owner-consent-client.js';
import type { createGooglePlatformPolicyClient } from './platform-client.js';
import { GoogleInferenceIdentitySchema, GooglePolicyDisclosureSchema } from './profile-resolution.js';
import { googleRuntimeIdentityDigest } from './runtime-authority.js';
import type { GoogleRunPin, GoogleRunPinStore } from './run-pins.js';

type Disclosure = z.infer<typeof GooglePolicyDisclosureSchema>;
export interface GoogleCollectionClientDependencies {
  registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>;
  resolveIdentity(binding: PiRuntimeBinding, signal: AbortSignal): Promise<GoogleInferenceIdentity | null>;
  policyClient: Pick<ReturnType<typeof createGooglePlatformPolicyClient>, 'authorize' | 'revalidate'>;
  contexts: Pick<GoogleContextStore, 'inspect' | 'mark'>;
  pins: Pick<GoogleRunPinStore, 'get'>;
  ownerConsentClient: Pick<ReturnType<typeof createGoogleOwnerConsentClient>, 'disclosures' | 'recordConsent'>;
  /** Must await affirmative interaction with the authenticated owner, including full-access chats.
   * Model/tool permission defaults cannot implement this callback. No private runtime facts are passed. */
  requestConsent(notice: { disclosure: Disclosure; expiresAt: string }, signal: AbortSignal): Promise<boolean>;
  purposeId?: string;
  requiredDataKinds?: z.infer<typeof GoogleDataKindsSchema>;
  now?: () => Date;
}
export class GoogleCollectionClientError extends Error {
  constructor() { super('Google data processing unavailable'); this.name = 'GoogleCollectionClientError'; }
}
function deny(): never { throw new GoogleCollectionClientError(); }
const MAX_AGE = 30 * 86400_000;
const allKinds = ['gmail-metadata', 'gmail-content', 'gmail-attachments', 'google-derived-context'] as const;
const origins = (context: GoogleContext) => context.sources.map(s => s.originId).sort();
const stampWithoutKinds = ({ dataKinds: _kinds, ...rest }: GoogleDataStamp) => rest;

/** Server-only pre-collection preparation. It never fetches mail, signs bytes or approves a provider.
 * The host must supply a canonical owned connection UUID and actual broker identity, then privately
 * sign the returned claim for the exact outgoing request. Receiver and inference release guards remain
 * mandatory. Conservative durable marks can remain after a subsequent denial; they contain no content.
 * A pre-existing run pin cannot expand to a new source/consent/route through this operation. */
export function createGoogleCollectionClient(deps: GoogleCollectionClientDependencies) {
  if (![deps.registry?.lookupRun, deps.registry?.inferenceSignal, deps.resolveIdentity, deps.policyClient?.authorize,
    deps.policyClient?.revalidate, deps.contexts?.inspect, deps.contexts?.mark, deps.pins?.get,
    deps.ownerConsentClient?.disclosures, deps.ownerConsentClient?.recordConsent, deps.requestConsent].every(v => typeof v === 'function')) deny();
  const purposeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/).parse(deps.purposeId ?? 'mail-assistance');
  const requiredKinds = GoogleDataKindsSchema.parse(deps.requiredDataKinds ?? [...allKinds]);
  if (!requiredKinds.includes('google-derived-context')) deny();
  const now = deps.now ?? (() => new Date());
  return {
    async prepare(bindingValue: PiRuntimeBinding, accountValue: string, inputSignal: AbortSignal): Promise<GoogleProcessingClaim> {
      try {
        const binding = structuredClone(bindingValue);
        const googleAccountId = z.uuid().parse(accountValue).toLowerCase();
        const lifetime = deps.registry.inferenceSignal(binding); if (!lifetime) deny();
        // Owner interaction is bounded independently of the registry's maximum run lifetime.
        const signal = AbortSignal.any([inputSignal, lifetime, AbortSignal.timeout(600000)]);
        const live = () => {
          if (signal.aborted || !isDeepStrictEqual(deps.registry.lookupRun(binding), binding)
            || deps.registry.inferenceSignal(binding) !== lifetime) deny();
        };
        async function checked<T>(operation: () => Promise<T>): Promise<T> {
          live(); let stop!: () => void;
          const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new GoogleCollectionClientError()); signal.addEventListener('abort', stop, { once: true }); });
          try { const value = await Promise.race([operation(), aborted]); live(); return value; }
          finally { signal.removeEventListener('abort', stop); }
        }
        const identity = GoogleInferenceIdentitySchema.parse(await checked(() => deps.resolveIdentity(binding, signal)));
        if (identity.api !== binding.route.api || identity.modelId !== binding.route.modelId) deny();
        const freshIdentity = async () => {
          const current = await checked(() => deps.resolveIdentity(binding, signal));
          if (!isDeepStrictEqual(current, identity)) deny();
        };
        const policyBinding = { runId: binding.runId, runtimeHandle: binding.runtimeHandle,
          executionGeneration: binding.executionGeneration, accessSourceId: binding.accessSourceId };
        const request = (dataKinds: z.infer<typeof GoogleDataKindsSchema>) => ({ binding: policyBinding, googleAccountId, purposeId, dataKinds, identity });
        const identityDigest = googleRuntimeIdentityDigest({ binding, identity });
        const inspect = () => checked(() => deps.contexts.inspect(binding.ownerId, binding.chatId));
        const getPin = () => checked(() => deps.pins.get(binding));
        const contextValid = (context: GoogleContext | null) => {
          if (context && (context.ownerId !== binding.ownerId || context.chatId !== binding.chatId || context.availability !== 'available'
            || Date.parse(context.retentionDeadline) <= now().getTime() || context.sources.length < 1 || context.sources.length > 32
            || context.sources.some(s => s.state !== 'active' || Date.parse(s.expiresAt) <= now().getTime()))) deny();
        };
        function pinValid(pin: GoogleRunPin | null, context: GoogleContext | null, stamp?: GoogleDataStamp) {
          contextValid(context); if (!pin) return;
          if (!context || pin.identityDigest !== identityDigest || !isDeepStrictEqual(pin.originIds, origins(context))
            || Date.parse(pin.expiresAt) <= now().getTime() || Date.parse(pin.retireAt) <= now().getTime()
            || pin.stamps.some(s => Date.parse(s.expiresAt) <= now().getTime())) deny();
          if (stamp) {
            const original = pin.stamps.find(s => s.googleAccountId === googleAccountId && s.purposeId === purposeId);
            if (!original || !isDeepStrictEqual(stampWithoutKinds(original), stampWithoutKinds(stamp))
              || !pin.originIds.includes(googleContextOriginId(binding.ownerId, googleAccountId, stamp.consentId))) deny();
          }
        }
        let context = await inspect(); let pin = await getPin(); pinValid(pin, context);
        const discovery = await checked(() => deps.policyClient.authorize(binding.ownerId, request(['gmail-metadata']), signal));
        if (pin && discovery.status === 'consent_required') deny();
        const profiles = await checked(() => deps.ownerConsentClient.disclosures(binding.ownerId, googleAccountId, signal));
        const selectedId = discovery.status === 'authorized' ? discovery.stamp.profileId : discovery.disclosure.profileId;
        const matches = profiles.filter(p => p.profileId === selectedId && p.purposeId === purposeId && p.googleAccountId === googleAccountId);
        if (matches.length !== 1) deny();
        const published: GoogleOwnerProfileDisclosure = matches[0]!;
        const disclosure = GooglePolicyDisclosureSchema.parse(Object.fromEntries(Object.entries(published)
          .filter(([key]) => !['connectionType', 'consentRevision', 'consentActive'].includes(key))));
        const sameNotice = (value: Disclosure | GoogleDataStamp) => {
          if (['profileId', 'profileRevision', 'googleAccountId', 'purposeId', 'evidenceRevision', 'disclosureRevision', 'retentionRevision']
            .some(key => value[key as keyof typeof value] !== disclosure[key as keyof Disclosure])) deny();
        };
        sameNotice(discovery.status === 'authorized' ? discovery.stamp : discovery.disclosure);
        if (disclosure.retention.mode !== 'duration' || disclosure.retention.maxAgeSeconds > MAX_AGE / 1000
          || requiredKinds.some(kind => !disclosure.dataKinds.includes(kind)) || Date.parse(disclosure.expiresAt) <= now().getTime()) deny();
        let result = await checked(() => deps.policyClient.authorize(binding.ownerId, request(disclosure.dataKinds), signal));
        if (result.status === 'consent_required') {
          if (pin || !isDeepStrictEqual(result.disclosure, disclosure) || result.consentRevision !== published.consentRevision) deny();
          const expiresAt = new Date(Math.min(now().getTime() + MAX_AGE, Date.parse(disclosure.expiresAt))).toISOString();
          const expectedConsentRevision = result.consentRevision;
          const accepted = await checked(() => deps.requestConsent(structuredClone({ disclosure, expiresAt }), signal));
          if (accepted !== true || Date.parse(expiresAt) <= now().getTime()) deny();
          await freshIdentity();
          // Recheck the exact notice and its CAS revision after UI; never submit a stale/new target implicitly.
          const current = await checked(() => deps.policyClient.authorize(binding.ownerId, request(disclosure.dataKinds), signal));
          if (current.status !== 'consent_required' || current.consentRevision !== expectedConsentRevision
            || !isDeepStrictEqual(current.disclosure, disclosure)) deny();
          await checked(() => deps.ownerConsentClient.recordConsent(binding.ownerId, {
            connectionId: googleAccountId, accepted: true, expectedConsentRevision, profileId: disclosure.profileId,
            profileRevision: disclosure.profileRevision, evidenceRevision: disclosure.evidenceRevision,
            disclosureRevision: disclosure.disclosureRevision, retentionRevision: disclosure.retentionRevision,
            purposeId, dataKinds: disclosure.dataKinds, expiresAt,
          }, signal));
          result = await checked(() => deps.policyClient.authorize(binding.ownerId, request(disclosure.dataKinds), signal));
          if (result.status !== 'authorized' || result.stamp.consentRevision !== expectedConsentRevision + 1 || result.stamp.expiresAt !== expiresAt) deny();
        }
        if (result.status !== 'authorized') deny();
        // From this point every check uses this exact grant, never a freshly authorized substitute.
        const stamp = GoogleDataStampSchema.parse(result.stamp); sameNotice(stamp);
        const originalRequest = { ...request(disclosure.dataKinds), stamp };
        const revalidate = async () => {
          const current = await checked(() => deps.policyClient.revalidate(binding.ownerId, originalRequest, signal));
          if (!isDeepStrictEqual(current.stamp, stamp) || Date.parse(stamp.expiresAt) <= now().getTime()) deny();
        };
        await freshIdentity(); await revalidate();
        context = await inspect(); pin = await getPin(); pinValid(pin, context, stamp);
        const retentionDeadline = new Date(Math.min(now().getTime() + disclosure.retention.maxAgeSeconds * 1000,
          Date.parse(stamp.expiresAt), now().getTime() + MAX_AGE)).toISOString();
        const marked = await checked(() => deps.contexts.mark({ ownerId: binding.ownerId, chatId: binding.chatId, googleAccountId,
          consentId: stamp.consentId, profileId: stamp.profileId, profileRevision: stamp.profileRevision, purposeId,
          expiresAt: stamp.expiresAt, retentionDeadline, ...(context ? { expectedRevision: context.revision } : {}) }));
        await freshIdentity(); await revalidate();
        const currentContext = await inspect();
        if (!isDeepStrictEqual(currentContext, marked)) deny();
        pinValid(await getPin(), currentContext, stamp);
        await freshIdentity(); await revalidate();
        live(); if (Date.parse(stamp.expiresAt) <= now().getTime()) deny();
        return { ownerId: binding.ownerId, googleAccountId, runId: binding.runId, runtimeHandle: binding.runtimeHandle,
          executionGeneration: binding.executionGeneration, profileId: stamp.profileId, profileRevision: stamp.profileRevision,
          consentId: stamp.consentId, consentRevision: stamp.consentRevision, purposeId, routeDigest: stamp.routeDigest, policyExpiresAt: stamp.expiresAt };
      } catch (_error) { throw new GoogleCollectionClientError(); }
    },
  };
}
