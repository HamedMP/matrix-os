import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BotRuntimeRegistry, PiRuntimeBinding } from '../../bots/runtime-registry.js';
import type { GoogleContext, GoogleContextStore } from './contexts.js';
import { GoogleDataStampSchema, type GoogleDataStamp } from '../profiles.js';
import { GoogleInferenceIdentitySchema } from './profile-resolution.js';
import type { createGooglePlatformPolicyClient } from './platform-client.js';
import type { GoogleDataInferenceAuthority } from './inference-policy.js';
import type { GoogleRunPinKey, GoogleRunPinStore } from './run-pins.js';

interface Dependencies {
  registry: Pick<BotRuntimeRegistry, 'lookupRun' | 'inferenceSignal'>;
  contexts: Pick<GoogleContextStore, 'inspect'>;
  pins: Pick<GoogleRunPinStore, 'get' | 'latch'>;
  policyClient: Pick<ReturnType<typeof createGooglePlatformPolicyClient>, 'authorize' | 'revalidate'>;
  now?: () => Date;
}
class RuntimePolicyUnavailable extends Error { constructor() { super('Google inference unavailable'); this.name = 'RuntimePolicyUnavailable'; } }
function deny(): never { throw new RuntimePolicyUnavailable(); }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sourceIds = (context: GoogleContext) => context.sources.map(source => source.originId).sort();

/** Broker-only composition. A null marker preserves ordinary runs but DOES NOT qualify unknown saved
 * history/imports/references: host admission must classify those before assembly. Nothing here scans content,
 * registers collection, approves a profile, or installs startup hooks. New Google sources after pinning need
 * a separate explicit collection-admission operation; this unit denies that change by default.
 * A new run may use fresh target-route consent for retained lineage, never revive expired/purged sources. */
export function createGoogleRuntimeInferenceAuthority(deps: Dependencies): GoogleDataInferenceAuthority {
  if (![deps.registry?.lookupRun, deps.registry?.inferenceSignal, deps.contexts?.inspect, deps.pins?.get,
    deps.pins?.latch, deps.policyClient?.authorize, deps.policyClient?.revalidate].every(value => typeof value === 'function')) deny();
  const now = deps.now ?? (() => new Date());
  return {
    async authorize(input) {
      try {
        if (input.phase !== 'dispatch' && input.phase !== 'release') deny();
        const binding: PiRuntimeBinding = structuredClone(input.binding);
        const observed = input.identity === null ? null : structuredClone(input.identity);
        const lifetime = deps.registry.inferenceSignal(binding);
        if (!lifetime) deny();
        const signal = AbortSignal.any([input.signal, lifetime, AbortSignal.timeout(30000)]);
        const live = () => {
          const current = deps.registry.lookupRun(binding);
          if (signal.aborted || !current || !isDeepStrictEqual(current, binding) || deps.registry.inferenceSignal(binding) !== lifetime) deny();
        };
        async function checked<T>(operation: () => Promise<T>): Promise<T> {
          live();
          let stop!: () => void;
          const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new RuntimePolicyUnavailable()); signal.addEventListener('abort', stop, { once: true }); });
          try { const result = await Promise.race([operation(), aborted]); live(); return result; }
          finally { signal.removeEventListener('abort', stop); }
        }
        live();
        const key: GoogleRunPinKey = { ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId,
          runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration };
        const context = await checked(() => deps.contexts.inspect(binding.ownerId, binding.chatId));
        let pin = await checked(() => deps.pins.get(key));
        if (!context) {
          if (pin) deny();
          if (await checked(() => deps.contexts.inspect(binding.ownerId, binding.chatId))) deny();
          // No non-Google pin: an explicitly admitted later collection can taint this same run.
          return { allowed: true, googleOrigin: false };
        }
        if (context.availability !== 'available' || context.ownerId !== binding.ownerId || context.chatId !== binding.chatId
          || context.sources.length < 1 || context.sources.length > 32 || Date.parse(context.retentionDeadline) <= now().getTime()) deny();
        if (!observed) deny();
        const identity = GoogleInferenceIdentitySchema.parse(observed);
        if (identity.api !== binding.route.api || identity.modelId !== binding.route.modelId) deny();
        const identityDigest = digest({ binding, identity }); const origins = sourceIds(context);
        const pairs = [...new Map(context.sources.map(source => [JSON.stringify([source.googleAccountId, source.purposeId]),
          { googleAccountId: source.googleAccountId, purposeId: source.purposeId }])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair);
        if (pairs.length < 1 || pairs.length > 32 || context.sources.some(s => s.state !== 'active' || Date.parse(s.expiresAt) <= now().getTime())) deny();
        const policyBinding = { runId: binding.runId, runtimeHandle: binding.runtimeHandle,
          executionGeneration: binding.executionGeneration, accessSourceId: binding.accessSourceId };
        const requestFor = (pair: { googleAccountId: string; purposeId: string }) => ({ binding: policyBinding, ...pair, dataKinds: ['google-derived-context'], identity });
        const sameContext = async () => {
          const current = await checked(() => deps.contexts.inspect(binding.ownerId, binding.chatId));
          if (!current || current.availability !== 'available' || !isDeepStrictEqual(current, context)) deny();
        };
        if (!pin) {
          if (input.phase !== 'dispatch') deny();
          const stamps: GoogleDataStamp[] = [];
          for (const pair of pairs) {
            const result = await checked(() => deps.policyClient.authorize(binding.ownerId, requestFor(pair), signal));
            if (result.status !== 'authorized') deny();
            stamps.push(GoogleDataStampSchema.parse(result.stamp));
          }
          await sameContext();
          pin = await checked(() => deps.pins.latch({ ...key, identityDigest, originIds: origins, stamps }));
        }
        if (pin.identityDigest !== identityDigest || !isDeepStrictEqual(pin.originIds, origins)
          || Date.parse(pin.expiresAt) <= now().getTime() || Date.parse(pin.retireAt) <= now().getTime()
          || pin.stamps.length !== pairs.length) deny();
        // Every phase revalidates ORIGINAL exact stamps, never authorize-and-substitute a new grant.
        for (let i = 0; i < pairs.length; i++) {
          const stamp = GoogleDataStampSchema.parse(pin.stamps[i]); const pair = pairs[i]!;
          if (stamp.ownerId !== binding.ownerId || stamp.googleAccountId !== pair.googleAccountId || stamp.purposeId !== pair.purposeId
            || !stamp.dataKinds.includes('google-derived-context') || Date.parse(stamp.expiresAt) <= now().getTime()) deny();
          const result = await checked(() => deps.policyClient.revalidate(binding.ownerId, { ...requestFor(pair), stamp }, signal));
          if (!isDeepStrictEqual(result.stamp, stamp)) deny();
        }
        await sameContext();
        if (pin.stamps.some(stamp => Date.parse(stamp.expiresAt) <= now().getTime())) deny();
        live(); return { allowed: true, googleOrigin: true };
      } catch {
        // Never expose provider account identity, policy state, credentials or underlying errors to the broker/model.
        return { allowed: false };
      }
    },
  };
}
